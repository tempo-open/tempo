# Pulling T3 Code stable releases

Tempo takes T3 Code's stable release tags (`vX.Y.Z`, no suffix) by applying upstream's diff, not by
merging: Tempo shares no history with T3 Code. `t3code-upstream.json` records the tag and commit
last synced. Upstream cuts a stable release by tagging a nightly's commit, so a stable tag syncs
exactly like a nightly. Never take a `-nightly`, `-preview` or `-alpha` tag.

1. Check whether a newer stable tag is ahead of the record:
   `gh api repos/pingdotgg/t3code/compare/<record commit>...<stable tag> --jq '{ahead_by, behind_by}'`.
   `ahead_by` 0 means Tempo already has it; if both are above 0, the tag is not on the line Tempo
   synced, so stop: the tag does not descend from the recorded commit.
2. On a new branch from an up-to-date main with a clean tree, run
   `vp run sync:upstream --to <stable tag>` ([tags](https://github.com/pingdotgg/t3code/tags)). It
   fetches both tags under `refs/t3code-upstream/` (about 300 MB the first time), applies their diff
   three-way, stages the updated record and prints what is left.
3. Resolve each conflict so Tempo's changes survive beside upstream's, then `git add` it. Tempo's code
   lives in `*/tempo/` folders; its edits inside upstream files carry `tempo:` comments.
4. The script lists separately what git refuses outright (a file one side deleted and the other
   changed): port each by hand or leave it out.
5. Upstream's `.github/` and `.repos/` are left out. Tempo ships no CI workflows; port the listed
   `.github/` changes only into workflows you add yourself. `vp run sync:repos` fetches the
   reference repos the release pins.
6. `vp i`, typecheck and test what changed, and commit with the record.

`git reset --hard` undoes an uncommitted sync, record included.
