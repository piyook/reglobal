// Conventional commits, with two allowances for Dependabot, which can't be
// told how to write its messages: a capital "Bump" in the subject, and
// bodies with long URLs.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [1, 'always', 100],
  },
  // Only Dependabot's own subject, so subject-case still holds for the rest.
  ignores: [(message) => /^chore(\([\w-]+\))?: Bump /.test(message)],
};
