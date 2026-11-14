# RAR archives for nzb.spec.ts

Only RAR itself makes RAR archives, and no runner has it, so these are made once and kept here.
Each holds `RAR_CONTENT` from `nzb.spec.ts`: `movie.mkv` (`seededBytes(30 * KB + 5, 81)`) and
`info.txt` (`seededBytes(KB, 82)`), stored (`-m0`).

| Files                              | Made with                            |
| ---------------------------------- | ------------------------------------ |
| `Multi.Release.part1.rar` to `3`   | RAR 7.01: `rar a -m0 -ma5 -v12k`     |
| `Old.Release.rar`, `.r00`, `.r01`  | RAR 6.23: `rar a -m0 -ma4 -vn -v12k` |
| `Locked.rar` (the files encrypted) | RAR 7.01: `rar a -m0 -ma5 -psecret`  |
| `Hidden.rar` (the names too)       | RAR 7.01: `rar a -m0 -ma5 -hpsecret` |

All with `-tsm- -tsc- -tsa- -ep`. RAR 7 no longer writes RAR 4 archives, hence 6.23 for the old
naming that goes with it. Both come from Debian's `non-free` `rar` package (bookworm and
bullseye).
