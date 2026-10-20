# Before you hand a framework model over

- [ ] `atticus frameworks check <name>` passes.
- [ ] `packages` names the framework's own modules only, never a public library.
- [ ] Every entry describes the framework, not one repo: no repo's paths, ids or URLs outside `tests` and `services`.
- [ ] Every entry's `source` is `document` or `person`, and its `ref` names the page, file or person its meaning came from.
- [ ] Every `services` value is cited, and none was guessed from a name.
- [ ] Every construct the survey showed in more than one repo is either in the model or listed in your hand-over with why it's left out.
- [ ] Each test's sample is copied from a real use and trimmed; there is a test for each variation you saw (object argument, positional, template string, constant).
- [ ] No secret, token or password is in the model or its tests.
- [ ] Your hand-over says what you read, what you left out, and what a person should confirm first.
