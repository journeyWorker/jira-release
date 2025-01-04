# Jira Version Release GitHub Action

[![GitHub Super-Linter](https://github.com/journeyWorker/jira-release/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/journeyWorker/jira-release/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/journeyWorker/jira-release/actions/workflows/check-dist.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/journeyWorker/jira-release/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/codeql-analysis.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

Automatically release Jira versions when a GitHub release is created. This
action helps synchronize your GitHub releases with Jira versions, making it
easier to track and manage releases across both platforms.

## Features

- Creates/Updates Jira versions based on GitHub releases
- Supports version name prefixing
- Configurable issue handling (skip subtasks and child issues)
- Provides detailed output of updated and failed issues

## Usage

```yaml
name: Release to Jira
on:
  release:
    types: [created]

permissions:
  contents: read
  pull_requests: read
  issues: read

jobs:
  release:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Release Jira Version
        uses: journeyWorker/jira-release@v1.1.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          jira-host: your-domain.atlassian.net
          jira-email: ${{ secrets.JIRA_EMAIL }}
          jira-token: ${{ secrets.JIRA_API_TOKEN }}
          project-prefix: PROJ
          jira-version-prefix: Mobile # Optional
```

## Inputs

| Input               | Required | Description                                                        | Default |
| ------------------- | -------- | ------------------------------------------------------------------ | ------- |
| github-token        | Yes      | GitHub token for accessing release information                     | -       |
| jira-host           | Yes      | Jira host URL                                                      |
| jira-email          | Yes      | Jira account email                                                 | -       |
| jira-token          | Yes      | Jira API token                                                     | -       |
| project-prefix      | Yes      | Jira project prefix (e.g., "VP" for VP-123)                        | -       |
| jira-version-prefix | No       | Prefix to add to version names (e.g., "Mobile" for "Mobile 1.0.0") | -       |
| skip-subtask        | No       | Skip subtasks when updating versions                               | false   |
| skip-child          | No       | Skip child issues when updating versions                           | false   |

## Outputs

| Output               | Description                                   |
| -------------------- | --------------------------------------------- |
| jira_issue_keys      | List of Jira issue keys that were updated     |
| fail_jira_issue_keys | List of Jira issue keys that failed to update |

## Development

### Prerequisites

- Node.js 21 or higher
- npm

### Setup

1. Clone the repository

```bash
git clone https://github.com/journeyWorker/jira-release.git
cd jira-release
```

1. Install dependencies

```bash
npm install
```

### Available Scripts

- `npm run test` - Run tests
- `npm run coverage` - Run tests with coverage report
- `npm run format:write` - Format code using Prettier
- `npm run lint` - Lint code using ESLint
- `npm run package` - Build the action
- `npm run all` - Run format, lint, test, coverage, and build

### Local Testing

You can test the action locally using the provided script:

```bash
npm run local-action
```

Make sure to set up your `.env` file based on the `.env.example` template.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file
for details.

## Inspiration

This project was inspired by the
[jira-issue-version-by-release-pr](https://github.com/PRNDcompany/jira-issue-version-by-release-pr)
but it was not triggered on PR not on release events.
