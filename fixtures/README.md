# Sample payment files

These are the inputs our readers are tested on. Tests that only read back our own output prove little, so these come from other people's code.

| File | Made by | Notes |
| --- | --- | --- |
| `pain.001.001.03.xml` | [`sepa`](https://www.npmjs.com/package/sepa) | USD credit transfers, 5 payees |
| `pain.001.001.09.xml` | [`sepa`](https://www.npmjs.com/package/sepa) | Same payments in the newer version |
| `payroll.ach` | [`nach2`](https://www.npmjs.com/package/nach2) | NACHA PPD payroll batch, 5 employees |
| `messy-export.csv` | Written by hand | CSV has no standard, so this imitates an awkward spreadsheet export |

`node fixtures/generate.mjs` rebuilds them. That script imports only the third-party libraries, never this repo's code.

Files with deliberate faults, such as a wrong control total, are made inside the tests by editing these files, so each test shows exactly what it broke.

All names and companies are invented. The IBANs are standard documentation examples, and the routing numbers are public test values.

These libraries are real but they are not ERP systems. A file from SAP, Oracle or Xero may use parts of the format these don't. See `packages/bankfiles/README.md` for what has and hasn't been tried.
