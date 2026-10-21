/**
 * The app's copy file: the words a person reads, kept in one place so they stay plain and
 * consistent. New screens take their words from here (CLAUDE.md, definition of done); older
 * screens still hold theirs inline and move here when they are next changed.
 */
export const COPY = {
  questions: {
    title: "Questions",
    intro:
      "When the code doesn't settle something, Atticus asks here. Your answer is written to the question's file in questions/; then run the command shown, and the step reads it.",
    filter: "Show",
    filterOpen: "Open",
    filterAll: "All",
    listTitle: "Questions",
    empty: "No questions are waiting. A scan step adds one here when the code is unclear.",
    emptyAll: "No questions yet. A scan step adds one here when the code is unclear.",
    unreadable: (file: string) => `${file} isn't a valid question file.`,
    pickFromList: "Pick a question from the list to answer it.",
    askedBy: (command: string, day: string) => `Asked by ${command} on ${day}`,
    evidence: "What it read",
    options: "Your answer",
    optionChanges: "It would change",
    ownWords: "In my own words",
    ownWordsLabel: "Your answer, in your own words",
    scope: "Who the answer is for",
    scopeRepo: (repo: string) => `This repo only (${repo})`,
    scopeType: (type: string) => `Every repo of type ${type}`,
    scopeTypeOther: "Every repo of a type",
    typeLabel: "The repo type",
    proposed: "proposed",
    submit: "Save the answer",
    saving: "Saving",
    pickOne: "Pick one of the options, or answer in your own words.",
    needWords: "Write your answer, or pick one of the options.",
    needType: "Say which repo type the answer is for, or keep it to this repo.",
    saved: (file: string) => `Saved to ${file}. Commit it for review with the rest of the scan.`,
    skillWritten: (path: string) => `Also written under Answers in ${path}.`,
    skillMissing: (path: string) =>
      `${path} isn't there yet, so the answer is kept in the question file, with that path.`,
    next: "Run this next; it reads your answer:",
    copy: "Copy the command",
    answered: (by: string, day: string) => `Answered by ${by} on ${day}`,
    retired: "This question is retired; nothing reads its answer.",
    change: "Change the answer",
  },
} as const;
