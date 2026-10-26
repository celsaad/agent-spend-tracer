# Saifuro verdict test vectors

`verdict-test-vectors.json` is an unmodified copy of
https://docs.saifuro.com/verdict-test-vectors.json, linked from
https://docs.saifuro.com/reference/verdict-test-vectors.

- Fetched: 2026-10-26
- SHA-256: `d29fa4996fb6eb604c030c867af3a51209744aa6dc8dcd8cfbcd94990f874f8b`
- Spec: draft-dias-agent-payment-verdicts-00, Section 6
  (https://www.ietf.org/archive/id/draft-dias-agent-payment-verdicts-00.txt)

**Test keys only.** The file includes the private halves of its test keys, published on
purpose so the vectors can be reproduced. Its issuers are `https://issuer.example` and
`https://issuer-b.example`. Never configure these keys or key sets in a verifier that
protects real payments.
