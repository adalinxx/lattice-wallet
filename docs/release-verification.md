# Release preparation evidence

Date: October 8, 2026. Candidate: 0.3.0 on the release-preparation branch, based on the branding commit 4f33ce4. This is preparation evidence, not public-release approval.

Passed: TypeScript checks; all 104 automated tests with both integration environment variables enabled (zero skipped); 22 explicit conformance checks; production dependency audit (zero reported vulnerabilities); package build and manifest asset checks.

The three ordinarily skipped integration tests were run explicitly:

- Deployed read smoke against https://lattice-mainnet-read.fly.dev passed. Nexus reported height 4888, minRelayFee 1 and acceptsSubmit true; testnet discovery returned https://lattice-mainnet-testnet.fly.dev and its chain was verified.
- Own-node authenticated submission passed against isolated local lattice-node processes. A transfer with fee 17 was included at block 3 and the recipient balance matched.
- Public-submit test passed against an isolated local node. Fee 0 was refused as belowMinRelayFee; fee 5 was included at block 3 and the recipient balance matched. A cheaper replacement was refused as feeTooLow.

The isolated tests used the newer node binaries in the 5d0c lattice-node worktree. An initial run against the older src/lattice-node binaries failed at startup because they do not recognize --no-default-peers; no submission occurred in that run.

Private vulnerability reporting has been enabled on the GitHub repository. The store dashboard was opened but redirected to Google sign-in, so publisher setup and submission are not complete.

Outstanding public-release gates: independent security audit and resolution; Chrome upgrade/recovery validation; a funded cross-chain trade on the deployed network; published policy links; publisher account and final store declarations. The existing cross-chain UI test uses simulated endpoints and must not be represented as deployed-chain evidence.

No user funds or keys were used for these checks. Three 1280×800 store screenshots were captured from the packaged extension in Chrome for Testing 151.0.7922.34, and inspected visually. scripts/store-screenshots.cjs uses a temporary Chrome profile with a disposable private key; that profile is removed after capture. Onboarding import and lock-screen rendering were exercised in this browser run. This does not cover every manual Chrome release gate.
