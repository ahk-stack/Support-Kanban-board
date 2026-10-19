# Support Kanban

## Patch notes: one line with every commit

Every commit adds a note to `patch-notes.json`, staged in the same commit. The
board shows these in the Feedback bubble's "Patch notes" tab, styled like a game
launcher's patch notes, so the people using the board see what changed.

- Add the note to the patch for today's date (`YYYY-MM-DD`). If there is no patch
  for today, add one at the top of `patches` with a short, catchy `title` (2-3
  words, like a game patch name: "Snooze & SLA", "Fresh Look"). A second commit
  on the same day appends to that patch; update its title if the day's theme changed.
- `type` is one of `new`, `improved`, `fixed`, `maintenance`.
- `text` is written for agents using the board, not for developers: plain English,
  one or two short sentences, what they will notice. No file names, function
  names, ticket numbers, or customer data. Name a person only for something
  friendly, such as welcoming them to a team.
- Internal-only work (data fixes, build or tooling changes) still gets a line, as
  `maintenance`, kept short and vague ("Behind-the-scenes tooling for ...").
- Do not include `commit`; the hash does not exist yet. It is optional and only
  added when backfilling.
