//! Nostro: payment-run controls and a ledger for a company's NEAR account.
//!
//! A company's accounting software exports a payment file. An off-chain service
//! reads it and submits a run here. This contract is what makes the finance
//! controls real rather than a promise in a web app:
//!
//! * Four eyes: the person who submitted a run can never approve it.
//! * Duplicate refusal: the same file, or the same payment line, cannot pay twice.
//! * Exact approval: an approval names the SHA-256 of what the approver saw.
//! * Payee cool-off: a new or changed payee is held, which blunts the
//!   "our bank details have changed" fraud.
//! * Limits: per-payment and daily caps checked when money moves.
//! * A ledger: every debit and credit carries a running balance, so a bank
//!   statement can be rebuilt from view calls alone, and checked against the
//!   token balance, with no indexer.
//!
//! Only hashes of names, account details and file contents are stored here.
//!
//! Staff act through function-call keys, which cannot attach a deposit. Owner
//! actions require one yoctoNEAR, so a staff key can never change roles or
//! limits. That is segregation of duties enforced by the protocol.

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, Value, json};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, LookupSet, Vector};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    assert_one_yocto, env, ext_contract, near, require,
};

const MAX_LINES_PER_RUN: usize = 100;
const MAX_REFERENCE_LEN: usize = 64;
const NANOS_PER_MINUTE: u64 = 60_000_000_000;
const NANOS_PER_DAY: u64 = 86_400_000_000_000;
/// A U128 as JSON fits easily. A token cannot run a callback out of gas by
/// returning something huge.
const MAX_RESULT_BYTES: usize = 128;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(60);
const GAS_ON_LINE_SETTLED: Gas = Gas::from_tgas(10);
const GAS_FT_BALANCE: Gas = Gas::from_tgas(5);
const GAS_ON_RECONCILE: Gas = Gas::from_tgas(10);
/// What creating a line burns in this call, on top of the gas forwarded to it:
/// send and exec fees for two function-call receipts plus the callback's data
/// receipt, about 15 Tgas. Leaving this out aborts a full-sized execute_run.
const GAS_LINE_OVERHEAD: Gas = Gas::from_tgas(16);
const GAS_RESERVE: Gas = Gas::from_tgas(25);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Makers,
    Checkers,
    Settlers,
    Payees,
    Runs,
    SeenMessages,
    SeenLines,
    Ledger,
    Statements,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    /// Submits runs and registers payees.
    Maker,
    /// Approves or rejects what a maker submitted.
    Checker,
    /// Executes approved runs and anchors statements. Cannot choose payees.
    Settler,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RunStatus {
    Submitted,
    Approved,
    Rejected,
    Executing,
    Completed,
    CompletedWithFailures,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LineStatus {
    Pending,
    Sending,
    Sent,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EntryKind {
    Debit,
    Credit,
}

/// A line as submitted by a maker.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LineInput {
    /// SHA-256 hex of the file's end-to-end id for this payment.
    pub e2e_hash: String,
    /// SHA-256 hex of the normalized payee identifier.
    pub payee_key: String,
    /// Payee account on testnet, or the 1Click deposit account on mainnet.
    pub receiver: AccountId,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RunLine {
    pub e2e_hash: String,
    pub payee_key: String,
    pub receiver: AccountId,
    pub amount: U128,
    pub status: LineStatus,
    pub settled_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Run {
    pub id: u64,
    pub message_hash: String,
    pub file_sha256: String,
    pub total: U128,
    pub maker: AccountId,
    pub approvals: Vec<AccountId>,
    pub status: RunStatus,
    pub created_at: U64,
    pub rejected_reason: Option<String>,
    pub lines: Vec<RunLine>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Payee {
    pub route_hash: String,
    /// When paying directly, the only account this payee can be paid at, so a
    /// run can't name an approved payee and send the money somewhere else.
    pub receiver: Option<AccountId>,
    pub registered_by: AccountId,
    pub approved_by: Option<AccountId>,
    /// Nanoseconds. Zero until a checker approves.
    pub active_after: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct LedgerEntry {
    pub seq: u64,
    pub ts: U64,
    pub block: U64,
    pub kind: EntryKind,
    pub amount: U128,
    pub balance_after: U128,
    pub run_id: Option<u64>,
    pub line: Option<u32>,
    pub reference: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct StatementAnchor {
    pub sha256: String,
    pub closing_balance: U128,
    pub last_seq: u64,
    pub block: U64,
    pub ts: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub owner: AccountId,
    pub token: AccountId,
    pub settlement_target: Option<AccountId>,
    pub required_approvals: u8,
    pub per_payment_limit: U128,
    pub daily_limit: U128,
    pub payee_cooloff_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Balances {
    /// Balance after every finished debit and credit.
    pub ledger: U128,
    /// Ledger balance less amounts now in flight.
    pub available: U128,
    pub spent_today: U128,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128>;
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait SelfCallbacks {
    fn on_line_settled(&mut self, run_id: u64, index: u32, amount: U128, via_call: bool);
    fn on_reconcile(&mut self, ledger_len: u32);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Nostro {
    owner: AccountId,
    token: AccountId,
    /// Set to `intents.near` on mainnet. Unset pays each receiver directly.
    settlement_target: Option<AccountId>,
    required_approvals: u8,
    per_payment_limit: u128,
    daily_limit: u128,
    payee_cooloff_ns: u64,
    makers: IterableSet<AccountId>,
    checkers: IterableSet<AccountId>,
    settlers: IterableSet<AccountId>,
    payees: LookupMap<String, Payee>,
    runs: IterableMap<u64, Run>,
    next_run_id: u64,
    seen_messages: LookupSet<String>,
    seen_lines: LookupSet<String>,
    ledger: Vector<LedgerEntry>,
    ledger_balance: u128,
    available_balance: u128,
    spent_day: u64,
    spent_today: u128,
    statements: IterableMap<String, StatementAnchor>,
}

#[near]
impl Nostro {
    #[init]
    pub fn new(
        owner: AccountId,
        token: AccountId,
        settlement_target: Option<AccountId>,
        required_approvals: u8,
        per_payment_limit: U128,
        daily_limit: U128,
        payee_cooloff_minutes: u32,
    ) -> Self {
        require!(required_approvals >= 1, "E_APPROVALS_MIN_1");
        Self {
            owner,
            token,
            settlement_target,
            required_approvals,
            per_payment_limit: per_payment_limit.0,
            daily_limit: daily_limit.0,
            payee_cooloff_ns: (payee_cooloff_minutes as u64) * NANOS_PER_MINUTE,
            makers: IterableSet::new(StorageKey::Makers),
            checkers: IterableSet::new(StorageKey::Checkers),
            settlers: IterableSet::new(StorageKey::Settlers),
            payees: LookupMap::new(StorageKey::Payees),
            runs: IterableMap::new(StorageKey::Runs),
            next_run_id: 1,
            seen_messages: LookupSet::new(StorageKey::SeenMessages),
            seen_lines: LookupSet::new(StorageKey::SeenLines),
            ledger: Vector::new(StorageKey::Ledger),
            ledger_balance: 0,
            available_balance: 0,
            spent_day: 0,
            spent_today: 0,
            statements: IterableMap::new(StorageKey::Statements),
        }
    }

    // ---------- Owner: needs a full-access key ----------

    #[payable]
    pub fn set_role(&mut self, account_id: AccountId, role: Role, enabled: bool) {
        self.assert_owner();
        let set = match role {
            Role::Maker => &mut self.makers,
            Role::Checker => &mut self.checkers,
            Role::Settler => &mut self.settlers,
        };
        if enabled {
            set.insert(account_id.clone());
        } else {
            set.remove(&account_id);
        }
        emit(
            "role_changed",
            json!({ "account_id": account_id, "role": role, "enabled": enabled }),
        );
    }

    #[payable]
    pub fn set_limits(&mut self, per_payment_limit: U128, daily_limit: U128) {
        self.assert_owner();
        self.per_payment_limit = per_payment_limit.0;
        self.daily_limit = daily_limit.0;
        emit(
            "limits_changed",
            json!({ "per_payment_limit": per_payment_limit, "daily_limit": daily_limit }),
        );
    }

    // ---------- Payee directory ----------

    /// Registers a payee, or changes the route of a known one. A change wipes
    /// the old approval, so new bank details never inherit trust.
    pub fn register_payee(
        &mut self,
        payee_key: String,
        route_hash: String,
        receiver: Option<AccountId>,
    ) {
        self.assert_role(Role::Maker);
        assert_hash(&payee_key, "E_BAD_PAYEE_KEY");
        assert_hash(&route_hash, "E_BAD_ROUTE_HASH");
        let existing = self.payees.get(&payee_key);
        let unchanged =
            existing.is_some_and(|p| p.route_hash == route_hash && p.receiver == receiver);
        if unchanged {
            return;
        }
        let changed = existing.is_some();
        self.payees.insert(
            payee_key.clone(),
            Payee {
                route_hash,
                receiver,
                registered_by: env::predecessor_account_id(),
                approved_by: None,
                active_after: U64(0),
            },
        );
        emit(
            if changed { "payee_changed" } else { "payee_registered" },
            json!({ "payee_key": payee_key }),
        );
    }

    pub fn approve_payee(&mut self, payee_key: String) {
        self.assert_role(Role::Checker);
        let approver = env::predecessor_account_id();
        let active_after = env::block_timestamp() + self.payee_cooloff_ns;
        let payee = self
            .payees
            .get_mut(&payee_key)
            .unwrap_or_else(|| env::panic_str("E_UNKNOWN_PAYEE"));
        require!(payee.registered_by != approver, "E_FOUR_EYES");
        payee.approved_by = Some(approver);
        payee.active_after = U64(active_after);
        emit(
            "payee_approved",
            json!({ "payee_key": payee_key, "active_after": U64(active_after) }),
        );
    }

    // ---------- Runs ----------

    pub fn submit_run(
        &mut self,
        message_hash: String,
        file_sha256: String,
        total: U128,
        lines: Vec<LineInput>,
    ) -> u64 {
        self.assert_role(Role::Maker);
        assert_hash(&message_hash, "E_BAD_MESSAGE_HASH");
        assert_hash(&file_sha256, "E_BAD_FILE_HASH");
        require!(
            !lines.is_empty() && lines.len() <= MAX_LINES_PER_RUN,
            "E_LINE_COUNT"
        );
        require!(
            self.seen_messages.insert(message_hash.clone()),
            "E_DUPLICATE_FILE"
        );

        let mut sum: u128 = 0;
        let mut run_lines = Vec::with_capacity(lines.len());
        for line in lines {
            assert_hash(&line.e2e_hash, "E_BAD_LINE_HASH");
            assert_hash(&line.payee_key, "E_BAD_PAYEE_KEY");
            require!(line.amount.0 > 0, "E_ZERO_AMOUNT");
            require!(
                line.amount.0 <= self.per_payment_limit,
                "E_OVER_PAYMENT_LIMIT"
            );
            require!(
                self.seen_lines.insert(line.e2e_hash.clone()),
                "E_DUPLICATE_LINE"
            );
            sum = sum
                .checked_add(line.amount.0)
                .unwrap_or_else(|| env::panic_str("E_OVERFLOW"));
            run_lines.push(RunLine {
                e2e_hash: line.e2e_hash,
                payee_key: line.payee_key,
                receiver: line.receiver,
                amount: line.amount,
                status: LineStatus::Pending,
                settled_at: U64(0),
            });
        }
        require!(sum == total.0, "E_CONTROL_SUM");

        let id = self.next_run_id;
        self.next_run_id += 1;
        let maker = env::predecessor_account_id();
        self.runs.insert(
            id,
            Run {
                id,
                message_hash,
                file_sha256: file_sha256.clone(),
                total,
                maker: maker.clone(),
                approvals: Vec::new(),
                status: RunStatus::Submitted,
                created_at: U64(env::block_timestamp()),
                rejected_reason: None,
                lines: run_lines,
            },
        );
        emit(
            "run_submitted",
            json!({ "run_id": id, "maker": maker, "total": total, "file_sha256": file_sha256 }),
        );
        id
    }

    /// `file_sha256` must match the run. An approval is for the exact file the
    /// approver saw, never "whatever is at id 7 by now".
    pub fn approve_run(&mut self, run_id: u64, file_sha256: String) {
        self.assert_role(Role::Checker);
        let approver = env::predecessor_account_id();
        let required = self.required_approvals as usize;
        let run = self
            .runs
            .get_mut(&run_id)
            .unwrap_or_else(|| env::panic_str("E_UNKNOWN_RUN"));
        require!(run.status == RunStatus::Submitted, "E_NOT_SUBMITTED");
        require!(run.maker != approver, "E_FOUR_EYES");
        require!(run.file_sha256 == file_sha256, "E_FILE_MISMATCH");
        require!(!run.approvals.contains(&approver), "E_ALREADY_APPROVED");
        run.approvals.push(approver.clone());
        if run.approvals.len() >= required {
            run.status = RunStatus::Approved;
        }
        let status = run.status;
        emit(
            "run_approved",
            json!({ "run_id": run_id, "approver": approver, "status": status }),
        );
    }

    /// Rejecting releases the file and its lines so a corrected file can follow.
    pub fn reject_run(&mut self, run_id: u64, reason: String) {
        self.assert_role(Role::Checker);
        require!(reason.len() <= MAX_REFERENCE_LEN * 4, "E_REASON_TOO_LONG");
        let run = self
            .runs
            .get_mut(&run_id)
            .unwrap_or_else(|| env::panic_str("E_UNKNOWN_RUN"));
        require!(run.status == RunStatus::Submitted, "E_NOT_SUBMITTED");
        run.status = RunStatus::Rejected;
        run.rejected_reason = Some(reason.clone());
        let message_hash = run.message_hash.clone();
        let hashes: Vec<String> = run.lines.iter().map(|l| l.e2e_hash.clone()).collect();
        self.seen_messages.remove(&message_hash);
        for hash in hashes {
            self.seen_lines.remove(&hash);
        }
        emit(
            "run_rejected",
            json!({ "run_id": run_id, "by": env::predecessor_account_id(), "reason": reason }),
        );
    }

    /// Sends up to `max_lines` pending lines. Lines whose payee is still in
    /// cool-off, or that would break a limit or the balance, are held and stay
    /// pending, so call again later. Returns how many lines were sent.
    pub fn execute_run(&mut self, run_id: u64, max_lines: u32) -> u32 {
        self.assert_role(Role::Settler);
        self.roll_day();
        let now = env::block_timestamp();

        let run = self
            .runs
            .get(&run_id)
            .unwrap_or_else(|| env::panic_str("E_UNKNOWN_RUN"));
        require!(
            matches!(run.status, RunStatus::Approved | RunStatus::Executing),
            "E_NOT_APPROVED"
        );

        let via_call = self.settlement_target.is_some();
        let per_line = if via_call {
            GAS_FT_TRANSFER_CALL
        } else {
            GAS_FT_TRANSFER
        }
        .saturating_add(GAS_ON_LINE_SETTLED)
        .saturating_add(GAS_LINE_OVERHEAD);
        let spare = env::prepaid_gas()
            .saturating_sub(env::used_gas())
            .saturating_sub(GAS_RESERVE);
        let by_gas = (spare.as_gas() / per_line.as_gas()) as u32;
        let limit = max_lines.min(by_gas);

        let mut chosen: Vec<(u32, AccountId, u128)> = Vec::new();
        let mut held: Vec<Value> = Vec::new();
        let mut available = self.available_balance;
        let mut spent = self.spent_today;
        for (index, line) in run.lines.iter().enumerate() {
            if chosen.len() as u32 >= limit {
                break;
            }
            if line.status != LineStatus::Pending {
                continue;
            }
            let index = index as u32;
            let amount = line.amount.0;
            let hold = match self.payees.get(&line.payee_key) {
                None => Some("payee_unknown"),
                Some(p) if p.approved_by.is_none() => Some("payee_unapproved"),
                Some(p) if now < p.active_after.0 => Some("payee_cooloff"),
                // Through Intents each payment has its own one-time deposit
                // account, so there is no fixed receiver to compare with.
                Some(p) if !via_call && p.receiver.as_ref() != Some(&line.receiver) => {
                    Some("receiver_mismatch")
                }
                Some(_) if amount > self.per_payment_limit => Some("over_payment_limit"),
                Some(_) if spent.saturating_add(amount) > self.daily_limit => {
                    Some("over_daily_limit")
                }
                Some(_) if amount > available => Some("insufficient_funds"),
                Some(_) => None,
            };
            match hold {
                Some(reason) => held.push(json!({ "line": index, "reason": reason })),
                None => {
                    available -= amount;
                    spent += amount;
                    chosen.push((index, line.receiver.clone(), amount));
                }
            }
        }

        let run = self.runs.get_mut(&run_id).unwrap();
        for (index, _, _) in &chosen {
            run.lines[*index as usize].status = LineStatus::Sending;
        }
        if !chosen.is_empty() {
            run.status = RunStatus::Executing;
        }
        self.available_balance = available;
        self.spent_today = spent;

        for hold in held {
            emit(
                "line_held",
                json!({ "run_id": run_id, "line": hold["line"], "reason": hold["reason"] }),
            );
        }

        let sent = chosen.len() as u32;
        for (index, receiver, amount) in chosen {
            let token = self.token.clone();
            let transfer = match &self.settlement_target {
                Some(target) => ext_ft::ext(token)
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(GAS_FT_TRANSFER_CALL)
                    .ft_transfer_call(
                        target.clone(),
                        U128(amount),
                        None,
                        receiver.to_string(),
                    ),
                None => ext_ft::ext(token)
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(GAS_FT_TRANSFER)
                    .ft_transfer(receiver, U128(amount), None),
            };
            transfer
                .then(
                    ext_self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_LINE_SETTLED)
                        .on_line_settled(run_id, index, U128(amount), via_call),
                )
                .detach();
        }
        sent
    }

    #[private]
    pub fn on_line_settled(&mut self, run_id: u64, index: u32, amount: U128, via_call: bool) {
        let used = match env::promise_result_checked(0, MAX_RESULT_BYTES) {
            Ok(bytes) if via_call => serde_json::from_slice::<U128>(&bytes)
                .map(|u| u.0)
                .unwrap_or(0),
            Ok(_) => amount.0,
            Err(_) => 0,
        };
        self.settle_line(run_id, index, amount.0, used);
    }

    // ---------- Money in ----------

    /// NEP-141 receiver. `msg` is the payer's reference, kept for reconciliation.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "E_WRONG_TOKEN");
        let reference = clip(&msg);
        self.ledger_balance += amount.0;
        self.available_balance += amount.0;
        let seq = self.append(EntryKind::Credit, amount.0, None, None, reference.clone());
        emit(
            "credit_received",
            json!({ "seq": seq, "from": sender_id, "amount": amount, "reference": reference }),
        );
        PromiseOrValue::Value(U128(0))
    }

    /// Compares the token's balance with the ledger. A 1Click refund arrives by
    /// plain transfer, so it is invisible until this records it. Anyone may call
    /// this, because all it can do is write down the truth.
    pub fn reconcile(&mut self) -> Promise {
        require!(
            self.ledger_balance == self.available_balance,
            "E_PAYMENTS_IN_FLIGHT"
        );
        let ledger_len = self.ledger.len();
        ext_ft::ext(self.token.clone())
            .with_static_gas(GAS_FT_BALANCE)
            .ft_balance_of(env::current_account_id())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_RECONCILE)
                    .on_reconcile(ledger_len),
            )
    }

    /// The balance was read a moment ago. If the ledger has moved since, or a
    /// payment has started, it may be stale, so nothing is written.
    #[private]
    pub fn on_reconcile(&mut self, ledger_len: u32) {
        if self.ledger.len() != ledger_len || self.ledger_balance != self.available_balance {
            emit("reconcile_skipped", json!({ "reason": "ledger_moved" }));
            return;
        }
        let balance = match env::promise_result_checked(0, MAX_RESULT_BYTES) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes)
                .unwrap_or_else(|_| env::panic_str("E_BAD_BALANCE"))
                .0,
            Err(_) => env::panic_str("E_BALANCE_CALL_FAILED"),
        };
        if balance == self.ledger_balance {
            emit("reconciled", json!({ "balance": U128(balance), "delta": "0" }));
            return;
        }
        let (kind, delta, reference) = if balance > self.ledger_balance {
            (
                EntryKind::Credit,
                balance - self.ledger_balance,
                "UNALLOCATED_CREDIT",
            )
        } else {
            (
                EntryKind::Debit,
                self.ledger_balance - balance,
                "UNEXPLAINED_DEBIT",
            )
        };
        self.ledger_balance = balance;
        self.available_balance = balance;
        let seq = self.append(kind, delta, None, None, reference.to_string());
        emit(
            "reconciled",
            json!({ "balance": U128(balance), "delta": U128(delta), "seq": seq, "kind": kind }),
        );
    }

    // ---------- Statements ----------

    /// Fixes a statement's hash on chain. The closing balance must equal the
    /// ledger at `last_seq`, so a statement that does not tie cannot be anchored.
    pub fn anchor_statement(
        &mut self,
        statement_id: String,
        sha256: String,
        closing_balance: U128,
        last_seq: u64,
    ) {
        self.assert_role(Role::Settler);
        assert_hash(&sha256, "E_BAD_FILE_HASH");
        require!(
            statement_id.len() <= MAX_REFERENCE_LEN,
            "E_STATEMENT_ID_TOO_LONG"
        );
        require!(
            !self.statements.contains_key(&statement_id),
            "E_STATEMENT_EXISTS"
        );
        let entry = self
            .ledger
            .get(last_seq as u32)
            .unwrap_or_else(|| env::panic_str("E_UNKNOWN_SEQ"));
        require!(
            entry.balance_after == closing_balance,
            "E_STATEMENT_DOES_NOT_TIE"
        );
        self.statements.insert(
            statement_id.clone(),
            StatementAnchor {
                sha256: sha256.clone(),
                closing_balance,
                last_seq,
                block: U64(env::block_height()),
                ts: U64(env::block_timestamp()),
            },
        );
        emit(
            "statement_anchored",
            json!({ "statement_id": statement_id, "sha256": sha256, "last_seq": last_seq }),
        );
    }

    // ---------- Views ----------

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            token: self.token.clone(),
            settlement_target: self.settlement_target.clone(),
            required_approvals: self.required_approvals,
            per_payment_limit: U128(self.per_payment_limit),
            daily_limit: U128(self.daily_limit),
            payee_cooloff_ns: U64(self.payee_cooloff_ns),
        }
    }

    pub fn get_balances(&self) -> Balances {
        Balances {
            ledger: U128(self.ledger_balance),
            available: U128(self.available_balance),
            spent_today: U128(self.spent_today),
        }
    }

    pub fn has_role(&self, account_id: AccountId, role: Role) -> bool {
        match role {
            Role::Maker => self.makers.contains(&account_id),
            Role::Checker => self.checkers.contains(&account_id),
            Role::Settler => self.settlers.contains(&account_id),
        }
    }

    pub fn get_run(&self, run_id: u64) -> Option<Run> {
        self.runs.get(&run_id).cloned()
    }

    pub fn list_runs(&self, from_index: u32, limit: u32) -> Vec<Run> {
        self.runs
            .values()
            .skip(from_index as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }

    pub fn get_payee(&self, payee_key: String) -> Option<Payee> {
        self.payees.get(&payee_key).cloned()
    }

    pub fn is_message_seen(&self, message_hash: String) -> bool {
        self.seen_messages.contains(&message_hash)
    }

    pub fn is_line_seen(&self, e2e_hash: String) -> bool {
        self.seen_lines.contains(&e2e_hash)
    }

    pub fn ledger_len(&self) -> u32 {
        self.ledger.len()
    }

    pub fn get_ledger(&self, from_seq: u32, limit: u32) -> Vec<LedgerEntry> {
        self.ledger
            .iter()
            .skip(from_seq as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }

    pub fn get_statement(&self, statement_id: String) -> Option<StatementAnchor> {
        self.statements.get(&statement_id).cloned()
    }
}

impl Nostro {
    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "E_NOT_OWNER");
    }

    fn assert_role(&self, role: Role) {
        let caller = env::predecessor_account_id();
        require!(self.has_role(caller, role), "E_NOT_AUTHORIZED");
    }

    fn roll_day(&mut self) {
        let day = env::block_timestamp() / NANOS_PER_DAY;
        if day != self.spent_day {
            self.spent_day = day;
            self.spent_today = 0;
        }
    }

    fn append(
        &mut self,
        kind: EntryKind,
        amount: u128,
        run_id: Option<u64>,
        line: Option<u32>,
        reference: String,
    ) -> u64 {
        let seq = self.ledger.len() as u64;
        self.ledger.push(LedgerEntry {
            seq,
            ts: U64(env::block_timestamp()),
            block: U64(env::block_height()),
            kind,
            amount: U128(amount),
            balance_after: U128(self.ledger_balance),
            run_id,
            line,
            reference,
        });
        seq
    }

    fn settle_line(&mut self, run_id: u64, index: u32, amount: u128, used: u128) {
        let unused = amount.saturating_sub(used);
        self.available_balance += unused;
        self.spent_today = self.spent_today.saturating_sub(unused);
        self.ledger_balance -= used.min(amount);

        let run = self
            .runs
            .get_mut(&run_id)
            .unwrap_or_else(|| env::panic_str("E_UNKNOWN_RUN"));
        let line = run
            .lines
            .get_mut(index as usize)
            .unwrap_or_else(|| env::panic_str("E_UNKNOWN_LINE"));
        let sent = used > 0;
        line.status = if sent {
            LineStatus::Sent
        } else {
            LineStatus::Failed
        };
        line.settled_at = U64(env::block_timestamp());
        let e2e_hash = line.e2e_hash.clone();

        let all_done = run
            .lines
            .iter()
            .all(|l| matches!(l.status, LineStatus::Sent | LineStatus::Failed));
        let any_failed = run.lines.iter().any(|l| l.status == LineStatus::Failed);
        if all_done {
            run.status = if any_failed {
                RunStatus::CompletedWithFailures
            } else {
                RunStatus::Completed
            };
        }
        let status = run.status;

        if sent {
            let seq = self.append(
                EntryKind::Debit,
                used.min(amount),
                Some(run_id),
                Some(index),
                e2e_hash,
            );
            emit(
                "line_sent",
                json!({ "run_id": run_id, "line": index, "amount": U128(used.min(amount)), "seq": seq }),
            );
        } else {
            // Free the line so a corrected file can pay it.
            self.seen_lines.remove(&e2e_hash);
            emit("line_failed", json!({ "run_id": run_id, "line": index }));
        }
        if all_done {
            emit("run_completed", json!({ "run_id": run_id, "status": status }));
        }
    }
}

fn clip(value: &str) -> String {
    value.chars().take(MAX_REFERENCE_LEN).collect()
}

fn assert_hash(value: &str, error: &str) {
    let ok = value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    require!(ok, error);
}

fn emit(event: &str, data: Value) {
    let envelope = json!({
        "standard": "nostro",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{envelope}"));
}

#[cfg(test)]
mod tests;
