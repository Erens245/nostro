//! Each test here backs one control the product claims to enforce.

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

const MINUTE: u64 = 60_000_000_000;
const USDC: u128 = 1_000_000;

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}
/// A valid 64-character hex string, distinct for each seed.
fn hash(seed: char) -> String {
    format!("{:064x}", seed as u32)
}
fn contract_id() -> AccountId {
    acc("nostro.testnet")
}
fn token() -> AccountId {
    acc("usdc.testnet")
}
fn owner() -> AccountId {
    acc("owner.testnet")
}
fn clerk() -> AccountId {
    acc("clerk.testnet")
}
fn cfo() -> AccountId {
    acc("cfo.testnet")
}
fn cfo2() -> AccountId {
    acc("controller.testnet")
}
fn settler() -> AccountId {
    acc("settler.testnet")
}
fn alice() -> AccountId {
    acc("alice.testnet")
}

fn ctx(caller: AccountId, now: u64, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .signer_account_id(caller.clone())
        .predecessor_account_id(caller)
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300))
        .attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}

/// Delivers a promise result to a callback.
fn callback_ctx(now: u64, result: PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .signer_account_id(settler())
        .predecessor_account_id(contract_id())
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(
        b.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn setup_with(
    target: Option<AccountId>,
    approvals: u8,
    per_payment: u128,
    daily: u128,
    cooloff_minutes: u32,
) -> Nostro {
    ctx(owner(), 1_000, 0);
    let mut c = Nostro::new(
        owner(),
        token(),
        target,
        approvals,
        U128(per_payment),
        U128(daily),
        cooloff_minutes,
    );
    ctx(owner(), 1_000, 1);
    c.set_role(clerk(), Role::Maker, true);
    ctx(owner(), 1_000, 1);
    c.set_role(cfo(), Role::Checker, true);
    ctx(owner(), 1_000, 1);
    c.set_role(cfo2(), Role::Checker, true);
    ctx(owner(), 1_000, 1);
    c.set_role(settler(), Role::Settler, true);
    c
}

fn setup() -> Nostro {
    setup_with(None, 1, 10_000 * USDC, 50_000 * USDC, 0)
}

fn fund(c: &mut Nostro, amount: u128, now: u64) {
    ctx(token(), now, 0);
    let _ = c.ft_on_transfer(owner(), U128(amount), "FUNDING".into());
}

fn line(e2e: char, payee: char, amount: u128) -> LineInput {
    LineInput {
        e2e_hash: hash(e2e),
        payee_key: hash(payee),
        receiver: alice(),
        amount: U128(amount),
    }
}

fn add_payee(c: &mut Nostro, payee: char, now: u64) {
    ctx(clerk(), now, 0);
    c.register_payee(hash(payee), hash('9'));
    ctx(cfo(), now, 0);
    c.approve_payee(hash(payee));
}

fn submit(c: &mut Nostro, msg: char, lines: Vec<LineInput>) -> u64 {
    let total: u128 = lines.iter().map(|l| l.amount.0).sum();
    ctx(clerk(), 2_000, 0);
    c.submit_run(hash(msg), hash('f'), U128(total), lines)
}

#[test]
fn a_run_flows_from_file_to_ledger() {
    let mut c = setup();
    fund(&mut c, 1_000 * USDC, 1_500);
    add_payee(&mut c, 'a', 1_600);

    let id = submit(&mut c, 'm', vec![line('1', 'a', 100 * USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    assert_eq!(c.get_run(id).unwrap().status, RunStatus::Approved);

    ctx(settler(), 4_000, 0);
    assert_eq!(c.execute_run(id, 10), 1);
    assert_eq!(c.get_balances().available.0, 900 * USDC);
    assert_eq!(
        c.get_balances().ledger.0,
        1_000 * USDC,
        "ledger waits for the transfer to finish"
    );

    callback_ctx(5_000, PromiseResult::Successful(vec![]));
    c.on_line_settled(id, 0, U128(100 * USDC), false);

    let run = c.get_run(id).unwrap();
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.lines[0].status, LineStatus::Sent);
    assert_eq!(c.get_balances().ledger.0, 900 * USDC);

    let ledger = c.get_ledger(0, 10);
    assert_eq!(ledger.len(), 2);
    assert_eq!(ledger[0].kind, EntryKind::Credit);
    assert_eq!(ledger[1].kind, EntryKind::Debit);
    assert_eq!(ledger[1].balance_after.0, 900 * USDC);
    assert_eq!(ledger[1].run_id, Some(id));
}

// ---------- Four eyes ----------

#[test]
#[should_panic(expected = "E_FOUR_EYES")]
fn a_maker_cannot_approve_their_own_run() {
    let mut c = setup();
    ctx(owner(), 1_000, 1);
    c.set_role(clerk(), Role::Checker, true);
    let id = submit(&mut c, 'm', vec![line('1', 'a', USDC)]);
    ctx(clerk(), 3_000, 0);
    c.approve_run(id, hash('f'));
}

#[test]
#[should_panic(expected = "E_FOUR_EYES")]
fn a_maker_cannot_approve_their_own_payee() {
    let mut c = setup();
    ctx(owner(), 1_000, 1);
    c.set_role(clerk(), Role::Checker, true);
    ctx(clerk(), 2_000, 0);
    c.register_payee(hash('a'), hash('9'));
    ctx(clerk(), 3_000, 0);
    c.approve_payee(hash('a'));
}

#[test]
#[should_panic(expected = "E_ALREADY_APPROVED")]
fn one_person_cannot_supply_two_approvals() {
    let mut c = setup_with(None, 2, 10_000 * USDC, 50_000 * USDC, 0);
    let id = submit(&mut c, 'm', vec![line('1', 'a', USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    ctx(cfo(), 3_001, 0);
    c.approve_run(id, hash('f'));
}

#[test]
fn two_approvals_are_needed_when_configured() {
    let mut c = setup_with(None, 2, 10_000 * USDC, 50_000 * USDC, 0);
    let id = submit(&mut c, 'm', vec![line('1', 'a', USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    assert_eq!(c.get_run(id).unwrap().status, RunStatus::Submitted);
    ctx(cfo2(), 3_001, 0);
    c.approve_run(id, hash('f'));
    assert_eq!(c.get_run(id).unwrap().status, RunStatus::Approved);
}

#[test]
#[should_panic(expected = "E_FILE_MISMATCH")]
fn an_approval_must_name_the_exact_file() {
    let mut c = setup();
    let id = submit(&mut c, 'm', vec![line('1', 'a', USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('0'));
}

// ---------- Roles ----------

#[test]
#[should_panic(expected = "E_NOT_AUTHORIZED")]
fn strangers_cannot_submit() {
    let mut c = setup();
    ctx(alice(), 2_000, 0);
    c.submit_run(hash('m'), hash('f'), U128(USDC), vec![line('1', 'a', USDC)]);
}

#[test]
#[should_panic(expected = "E_NOT_AUTHORIZED")]
fn a_maker_cannot_execute() {
    let mut c = setup();
    let id = submit(&mut c, 'm', vec![line('1', 'a', USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    ctx(clerk(), 4_000, 0);
    c.execute_run(id, 10);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn a_function_call_key_cannot_change_roles() {
    let mut c = setup();
    // A function-call key can attach no deposit, so this is what it sees.
    ctx(owner(), 2_000, 0);
    c.set_role(clerk(), Role::Checker, true);
}

#[test]
#[should_panic(expected = "E_NOT_OWNER")]
fn only_the_owner_changes_limits() {
    let mut c = setup();
    ctx(cfo(), 2_000, 1);
    c.set_limits(U128(u128::MAX), U128(u128::MAX));
}

// ---------- Duplicates ----------

#[test]
#[should_panic(expected = "E_DUPLICATE_FILE")]
fn the_same_file_cannot_be_sent_twice() {
    let mut c = setup();
    submit(&mut c, 'm', vec![line('1', 'a', USDC)]);
    submit(&mut c, 'm', vec![line('2', 'a', USDC)]);
}

#[test]
#[should_panic(expected = "E_DUPLICATE_LINE")]
fn the_same_payment_cannot_hide_in_a_new_file() {
    let mut c = setup();
    submit(&mut c, 'm', vec![line('1', 'a', USDC)]);
    submit(&mut c, 'n', vec![line('1', 'a', USDC)]);
}

#[test]
#[should_panic(expected = "E_DUPLICATE_LINE")]
fn a_line_cannot_repeat_inside_one_file() {
    let mut c = setup();
    submit(&mut c, 'm', vec![line('1', 'a', USDC), line('1', 'a', USDC)]);
}

#[test]
fn rejecting_frees_the_file_for_a_correction() {
    let mut c = setup();
    let id = submit(&mut c, 'm', vec![line('1', 'a', USDC)]);
    ctx(cfo(), 3_000, 0);
    c.reject_run(id, "Wrong amount".into());
    assert!(!c.is_message_seen(hash('m')));
    assert!(!c.is_line_seen(hash('1')));
    let again = submit(&mut c, 'm', vec![line('1', 'a', 2 * USDC)]);
    assert_ne!(id, again);
}

// ---------- Control totals ----------

#[test]
#[should_panic(expected = "E_CONTROL_SUM")]
fn the_control_sum_must_match() {
    let mut c = setup();
    ctx(clerk(), 2_000, 0);
    c.submit_run(
        hash('m'),
        hash('f'),
        U128(USDC + 1),
        vec![line('1', 'a', USDC)],
    );
}

#[test]
#[should_panic(expected = "E_ZERO_AMOUNT")]
fn zero_payments_are_refused() {
    let mut c = setup();
    submit(&mut c, 'm', vec![line('1', 'a', 0)]);
}

// ---------- Payees ----------

#[test]
fn a_new_payee_waits_out_the_cooloff() {
    let mut c = setup_with(None, 1, 10_000 * USDC, 50_000 * USDC, 60);
    fund(&mut c, 100 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    let id = submit(&mut c, 'm', vec![line('1', 'a', USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));

    ctx(settler(), 30 * MINUTE, 0);
    assert_eq!(c.execute_run(id, 10), 0, "held in cool-off");
    assert_eq!(c.get_run(id).unwrap().lines[0].status, LineStatus::Pending);

    ctx(settler(), 61 * MINUTE, 0);
    assert_eq!(c.execute_run(id, 10), 1, "released after cool-off");
}

#[test]
fn changed_payment_details_lose_their_approval() {
    let mut c = setup();
    fund(&mut c, 100 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    assert!(c.get_payee(hash('a')).unwrap().approved_by.is_some());

    // The fraud: the supplier's details are quietly swapped.
    ctx(clerk(), 2_500, 0);
    c.register_payee(hash('a'), hash('8'));
    let payee = c.get_payee(hash('a')).unwrap();
    assert!(payee.approved_by.is_none());
    assert_eq!(payee.active_after.0, 0);

    let id = submit(&mut c, 'm', vec![line('1', 'a', USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    ctx(settler(), 4_000, 0);
    assert_eq!(c.execute_run(id, 10), 0, "changed payee cannot be paid");
}

#[test]
fn registering_the_same_details_keeps_the_approval() {
    let mut c = setup();
    add_payee(&mut c, 'a', 2_000);
    ctx(clerk(), 2_500, 0);
    c.register_payee(hash('a'), hash('9'));
    assert!(c.get_payee(hash('a')).unwrap().approved_by.is_some());
}

#[test]
fn an_unknown_payee_is_held_and_money_stays() {
    let mut c = setup();
    fund(&mut c, 100 * USDC, 1_500);
    let id = submit(&mut c, 'm', vec![line('1', 'z', USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    ctx(settler(), 4_000, 0);
    assert_eq!(c.execute_run(id, 10), 0);
    assert_eq!(c.get_balances().available.0, 100 * USDC);
}

// ---------- Limits and funds ----------

#[test]
#[should_panic(expected = "E_OVER_PAYMENT_LIMIT")]
fn a_payment_over_the_limit_is_refused() {
    let mut c = setup_with(None, 1, 500 * USDC, 50_000 * USDC, 0);
    submit(&mut c, 'm', vec![line('1', 'a', 501 * USDC)]);
}

#[test]
fn the_daily_limit_holds_the_excess() {
    let mut c = setup_with(None, 1, 10_000 * USDC, 150 * USDC, 0);
    fund(&mut c, 1_000 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    let id = submit(
        &mut c,
        'm',
        vec![line('1', 'a', 100 * USDC), line('2', 'a', 100 * USDC)],
    );
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    ctx(settler(), 4_000, 0);
    assert_eq!(c.execute_run(id, 10), 1, "second line is over the cap");
    assert_eq!(c.get_run(id).unwrap().lines[1].status, LineStatus::Pending);
}

#[test]
fn the_daily_limit_resets_the_next_day() {
    let mut c = setup_with(None, 1, 10_000 * USDC, 150 * USDC, 0);
    fund(&mut c, 1_000 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    let id = submit(
        &mut c,
        'm',
        vec![line('1', 'a', 100 * USDC), line('2', 'a', 100 * USDC)],
    );
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    ctx(settler(), 4_000, 0);
    assert_eq!(c.execute_run(id, 10), 1);
    callback_ctx(5_000, PromiseResult::Successful(vec![]));
    c.on_line_settled(id, 0, U128(100 * USDC), false);

    ctx(settler(), NANOS_PER_DAY + 1, 0);
    assert_eq!(c.execute_run(id, 10), 1);
}

#[test]
fn a_line_without_funds_waits() {
    let mut c = setup();
    fund(&mut c, 50 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    let id = submit(&mut c, 'm', vec![line('1', 'a', 100 * USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    ctx(settler(), 4_000, 0);
    assert_eq!(c.execute_run(id, 10), 0);
    assert_eq!(c.get_balances().available.0, 50 * USDC);
}

#[test]
#[should_panic(expected = "E_NOT_APPROVED")]
fn an_unapproved_run_cannot_move_money() {
    let mut c = setup();
    fund(&mut c, 100 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    let id = submit(&mut c, 'm', vec![line('1', 'a', USDC)]);
    ctx(settler(), 4_000, 0);
    c.execute_run(id, 10);
}

#[test]
#[should_panic(expected = "E_NOT_APPROVED")]
fn a_rejected_run_cannot_move_money() {
    let mut c = setup();
    fund(&mut c, 100 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    let id = submit(&mut c, 'm', vec![line('1', 'a', USDC)]);
    ctx(cfo(), 3_000, 0);
    c.reject_run(id, "No".into());
    ctx(settler(), 4_000, 0);
    c.execute_run(id, 10);
}

// ---------- Settlement ----------

#[test]
fn a_failed_transfer_restores_money_and_frees_the_line() {
    let mut c = setup();
    fund(&mut c, 100 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    let id = submit(&mut c, 'm', vec![line('1', 'a', 40 * USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    ctx(settler(), 4_000, 0);
    c.execute_run(id, 10);
    assert_eq!(c.get_balances().available.0, 60 * USDC);

    callback_ctx(5_000, PromiseResult::Failed);
    c.on_line_settled(id, 0, U128(40 * USDC), false);

    let run = c.get_run(id).unwrap();
    assert_eq!(run.status, RunStatus::CompletedWithFailures);
    assert_eq!(run.lines[0].status, LineStatus::Failed);
    assert_eq!(c.get_balances().available.0, 100 * USDC);
    assert_eq!(c.get_balances().ledger.0, 100 * USDC);
    assert_eq!(c.get_balances().spent_today.0, 0);
    assert!(!c.is_line_seen(hash('1')), "a corrected file can pay it");
    assert_eq!(c.get_ledger(0, 10).len(), 1, "no debit was written");
}

#[test]
fn intents_deposit_counts_only_what_the_verifier_kept() {
    let mut c = setup_with(
        Some(acc("intents.near")),
        1,
        10_000 * USDC,
        50_000 * USDC,
        0,
    );
    fund(&mut c, 100 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    let id = submit(&mut c, 'm', vec![line('1', 'a', 40 * USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    ctx(settler(), 4_000, 0);
    assert_eq!(c.execute_run(id, 10), 1);

    // ft_transfer_call returning "0" means the verifier refused everything.
    let refused = serde_json::to_vec(&U128(0)).unwrap();
    callback_ctx(5_000, PromiseResult::Successful(refused));
    c.on_line_settled(id, 0, U128(40 * USDC), true);
    assert_eq!(c.get_run(id).unwrap().lines[0].status, LineStatus::Failed);
    assert_eq!(c.get_balances().available.0, 100 * USDC);
}

#[test]
fn intents_deposit_succeeds_when_fully_used() {
    let mut c = setup_with(
        Some(acc("intents.near")),
        1,
        10_000 * USDC,
        50_000 * USDC,
        0,
    );
    fund(&mut c, 100 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    let id = submit(&mut c, 'm', vec![line('1', 'a', 40 * USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    ctx(settler(), 4_000, 0);
    c.execute_run(id, 10);

    let used = serde_json::to_vec(&U128(40 * USDC)).unwrap();
    callback_ctx(5_000, PromiseResult::Successful(used));
    c.on_line_settled(id, 0, U128(40 * USDC), true);
    assert_eq!(c.get_run(id).unwrap().status, RunStatus::Completed);
    assert_eq!(c.get_balances().ledger.0, 60 * USDC);
}

#[test]
fn executing_twice_cannot_pay_twice() {
    let mut c = setup();
    fund(&mut c, 100 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    let id = submit(&mut c, 'm', vec![line('1', 'a', 40 * USDC)]);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    ctx(settler(), 4_000, 0);
    assert_eq!(c.execute_run(id, 10), 1);
    ctx(settler(), 4_001, 0);
    assert_eq!(c.execute_run(id, 10), 0, "line is already in flight");
    assert_eq!(c.get_balances().available.0, 60 * USDC);
}

#[test]
fn a_large_run_is_split_across_calls() {
    let mut c = setup();
    fund(&mut c, 1_000 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    let lines: Vec<LineInput> = "0123456789abcdef"
        .chars()
        .map(|ch| line(ch, 'a', USDC))
        .collect();
    let id = submit(&mut c, 'm', lines);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));
    ctx(settler(), 4_000, 0);
    assert_eq!(c.execute_run(id, 5), 5);

    // Asking for far more than one call can carry must send what fits, not abort.
    let mut sent = 5;
    for tick in 0..10 {
        ctx(settler(), 4_001 + tick, 0);
        let n = c.execute_run(id, 1_000);
        if n == 0 {
            break;
        }
        assert!(n < 16, "one call must not try to send everything");
        sent += n;
    }
    assert_eq!(sent, 16);
}

#[test]
fn a_full_sized_run_fits_the_gas_budget() {
    let mut c = setup_with(
        Some(acc("intents.near")),
        1,
        10_000 * USDC,
        50_000 * USDC,
        0,
    );
    fund(&mut c, 1_000 * USDC, 1_500);
    add_payee(&mut c, 'a', 2_000);
    let lines: Vec<LineInput> = (0..MAX_LINES_PER_RUN as u32)
        .map(|i| LineInput {
            e2e_hash: format!("{:064x}", i + 1),
            payee_key: hash('a'),
            receiver: alice(),
            amount: U128(USDC),
        })
        .collect();
    let id = submit(&mut c, 'm', lines);
    ctx(cfo(), 3_000, 0);
    c.approve_run(id, hash('f'));

    let mut sent = 0;
    for tick in 0..60 {
        ctx(settler(), 4_000 + tick, 0);
        let n = c.execute_run(id, 1_000);
        if n == 0 {
            break;
        }
        sent += n;
    }
    assert_eq!(sent as usize, MAX_LINES_PER_RUN);
}

// ---------- Money in ----------

#[test]
fn credits_keep_the_payers_reference() {
    let mut c = setup();
    ctx(token(), 1_500, 0);
    let _ = c.ft_on_transfer(acc("customer.testnet"), U128(5 * USDC), "INV-2041".into());
    let entry = &c.get_ledger(0, 1)[0];
    assert_eq!(entry.kind, EntryKind::Credit);
    assert_eq!(entry.reference, "INV-2041");
    assert_eq!(c.get_balances().ledger.0, 5 * USDC);
}

#[test]
#[should_panic(expected = "E_WRONG_TOKEN")]
fn only_the_configured_token_can_credit() {
    let mut c = setup();
    ctx(acc("fake-usdc.testnet"), 1_500, 0);
    let _ = c.ft_on_transfer(alice(), U128(5 * USDC), String::new());
}

#[test]
fn a_long_reference_is_clipped() {
    let mut c = setup();
    ctx(token(), 1_500, 0);
    let _ = c.ft_on_transfer(alice(), U128(USDC), "x".repeat(500));
    assert_eq!(c.get_ledger(0, 1)[0].reference.len(), MAX_REFERENCE_LEN);
}

// ---------- Reconcile ----------

#[test]
fn a_silent_refund_is_written_down() {
    let mut c = setup();
    fund(&mut c, 100 * USDC, 1_500);
    let token_says = serde_json::to_vec(&U128(103 * USDC)).unwrap();
    callback_ctx(5_000, PromiseResult::Successful(token_says));
    c.on_reconcile();
    assert_eq!(c.get_balances().ledger.0, 103 * USDC);
    let entry = &c.get_ledger(1, 1)[0];
    assert_eq!(entry.kind, EntryKind::Credit);
    assert_eq!(entry.amount.0, 3 * USDC);
    assert_eq!(entry.reference, "UNALLOCATED_CREDIT");
}

#[test]
fn a_balanced_ledger_writes_nothing() {
    let mut c = setup();
    fund(&mut c, 100 * USDC, 1_500);
    let token_says = serde_json::to_vec(&U128(100 * USDC)).unwrap();
    callback_ctx(5_000, PromiseResult::Successful(token_says));
    c.on_reconcile();
    assert_eq!(c.ledger_len(), 1);
}

// ---------- Statements ----------

#[test]
fn a_statement_that_ties_can_be_anchored() {
    let mut c = setup();
    fund(&mut c, 100 * USDC, 1_500);
    ctx(settler(), 2_000, 0);
    c.anchor_statement("2026-11-07".into(), hash('s'), U128(100 * USDC), 0);
    assert_eq!(
        c.get_statement("2026-11-07".into()).unwrap().sha256,
        hash('s')
    );
}

#[test]
#[should_panic(expected = "E_STATEMENT_DOES_NOT_TIE")]
fn a_statement_that_does_not_tie_is_refused() {
    let mut c = setup();
    fund(&mut c, 100 * USDC, 1_500);
    ctx(settler(), 2_000, 0);
    c.anchor_statement("2026-11-07".into(), hash('s'), U128(99 * USDC), 0);
}

#[test]
#[should_panic(expected = "E_STATEMENT_EXISTS")]
fn an_anchored_statement_cannot_be_replaced() {
    let mut c = setup();
    fund(&mut c, 100 * USDC, 1_500);
    ctx(settler(), 2_000, 0);
    c.anchor_statement("2026-11-07".into(), hash('s'), U128(100 * USDC), 0);
    ctx(settler(), 2_001, 0);
    c.anchor_statement("2026-11-07".into(), hash('t'), U128(100 * USDC), 0);
}
