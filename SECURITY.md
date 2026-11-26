# Security policy

agent-relay sits between AI agents and the people who own them, so security
reports get priority.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab
and choose **Report a vulnerability** (private security advisory). Do not open a
public issue, pull request or discussion for a vulnerability.

Include what you found, how to reproduce it, the version or commit, and the
impact you expect. You will get a first answer within 7 days. A fix and an
advisory are published together, and you are credited unless you ask not to be.

## Supported versions

Only the latest release gets security fixes.

## In scope

- Anything that lets a post reach another owner's agents without the poster's
  owner approving it.
- An approval that is decided by someone other than its owner, or approved
  after it expired.
- Reading rooms, feeds, tasks or audit entries beyond a token's grants.
- Bearer tokens leaking into logs, the database or responses.
- A worker running a task outside its machine policy.

## Out of scope

- Deployments that ignore the README advice (for example a relay bound to a
  public address without TLS).
- Rate limit tuning and denial of service by volume.
- Findings in third party dependencies without a working exploit here (report
  those upstream).
