# Support Kanban — Git Guide for Account Managers

Welcome! 👋 This guide explains how we work together on the **Support Kanban**
project using Git. You don't need to be a developer — just follow the steps
below and you'll be fine.

---

## 📌 The golden rules

1. We work on the **`staging`** branch by default.
2. For every new feature or change, **create your own branch** off `staging`.
3. When your work is ready, **contact Wajdi** — he reviews, merges, and deploys.
4. **Never commit passwords, API keys, tokens, or `.env` files.**

---

## 🛠️ One-time setup (do this once per computer)

**1. Download the project (clone):**

```bash
git clone ssh://git@git.gotogo.im/am/support-kanban.git
cd support-kanban
```

**2. Tell Git who you are** (so your work is credited to you):

```bash
git config --global user.name "Your Full Name"
git config --global user.email "you@quinta.im"
```

That's it — you're ready to work.

---

## 🔁 Daily workflow

Follow these 5 steps every time you work on something new.

```bash
# 1. Go to staging and get the latest version
git checkout staging
git pull

# 2. Create a new branch for your feature or change
#    Use a short, descriptive name: feature/... or fix/...
git checkout -b feature/short-description

# 3. Do your work, then save it (commit)
git add .
git commit -m "Add: short description of what you did"

# 4. Send your branch to the server
git push -u origin feature/short-description
```

**5. Tell Wajdi it's ready** (Slack / email: `wis@quinta.im`).
He will review your branch, merge it into `staging`, and deploy the app. ✅

> ❌ Do **not** merge or deploy yourself. Step 5 is handled by Wajdi.

---

## 🌿 How branches fit together

```
feature/your-work  ──►  staging  ──►  (deploy)
     you work here    Wajdi merges     Wajdi deploys
```

- **`staging`** — the shared, default branch. Always start from here.
- **`feature/...`** — your personal branch for one feature or change.
- Many people can have their own feature branches at the same time without
  stepping on each other.

**Branch naming examples:**

| Type of work        | Branch name example              |
| ------------------- | -------------------------------- |
| New feature         | `feature/export-tickets-to-csv`  |
| Fixing a problem    | `fix/wrong-ticket-status`        |
| Text / content edit | `content/update-faq-wording`     |

---

## ✅ Best practices

- **Always `git pull` on `staging` before starting.** This avoids conflicts.
- **One feature = one branch.** Don't mix unrelated changes together.
- **Commit often, with clear messages.** "Add login button" beats "stuff".
- **Never work directly on `staging`** for new features — always branch.
- **Never commit secrets** — no passwords, API keys, tokens, or `.env` files
  (see `.gitignore`, which already blocks the common ones).
- **When unsure, ask before** force-pushing, deleting branches, or rewriting
  history. These actions are hard to undo.

---

## 📖 Command cheat sheet

| What you want to do                     | Command                                 |
| --------------------------------------- | --------------------------------------- |
| See what branch you're on               | `git status`                            |
| Get the latest version of this branch   | `git pull`                              |
| Switch to staging                       | `git checkout staging`                  |
| Create a new branch                     | `git checkout -b feature/my-thing`      |
| See your branches                       | `git branch`                            |
| Save your changes locally               | `git add .` then `git commit -m "..."`  |
| Send your branch to the server          | `git push -u origin feature/my-thing`   |
| See your recent commits                 | `git log --oneline -10`                 |

---

## ❓ Need help?

- **To merge / deploy:** contact **Wajdi** — `wis@quinta.im`
- **Stuck or made a mistake?** Don't try to "fix" it with risky commands —
  ping Wajdi. It's almost always easy to recover if you ask early.
