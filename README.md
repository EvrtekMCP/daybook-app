# Daybook app shell

The finished program files of **Daybook**, a small family app by REIMERTEK STUDIOS, so
that the copies installed on a family PC can update themselves.

**There is no personal data here, and there never will be:** no names, no calendars, no
addresses, no keys, no photos. Those live only on the one PC Daybook runs on, and in the
family's own Google account.

- `latest.json` names the newest release and lists every file with its SHA-256 fingerprint.
- `releases/<version>/` holds each release, unchanged once published.

An installed copy checks `latest.json` once a night, downloads a newer release, checks
every file against its fingerprint, and switches over only if the new version starts;
otherwise it goes back to the one it had.
