import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as core from '@actions/core'
import * as github from '@actions/github'
import got from 'got'
import {
  run,
  Issue,
  getJiraVersionName,
  getPullRequestInfo,
  extractJiraIssueKeys,
  validateAndFilterIssues,
  JiraClient
} from './main.js'

type GitHub = ReturnType<typeof github.getOctokit>
// Mock got module
const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPut = vi.fn()
// Mock got module
vi.mock('got', () => ({
  default: {
    extend: () => ({
      get: (url: string) => {
        return {
          json: async () => {
            if (url.includes('/issue/')) {
              const issueKey = url.split('/').pop()
              if (!issueKey) throw new Error('Invalid URL')
              const issue = mockJiraIssues[issueKey]
              if (!issue) throw new Error('Issue not found')
              return {
                fields: {
                  ...issue.fields,
                  issuetype: { ...issue.fields.issuetype },
                  fixVersions: [...issue.fields.fixVersions],
                  parent: issue.fields.parent
                    ? { ...issue.fields.parent }
                    : null
                }
              }
            }
            if (url.includes('/versions')) {
              return [{ id: '123', name: '1.0.0' }]
            }
            return {}
          }
        }
      },
      post: mockPost,
      put: mockPut
    })
  }
}))
vi.mock('@actions/core')
vi.mock('@actions/github')

// Mock GitHub context
const mockContext = {
  eventName: 'release',
  payload: {
    release: {
      tag_name: 'v0.0.15',
      body: `<!-- Release notes generated using configuration in .github/release.yaml at v1.0.0 -->

## What's Changed
### New Moves Learned ⚡
* feat: teach Pikachu to make coffee by @ashketchum in https://github.com/PokemonCenter/pikabot/pull/151
* feat: implement coffee grinder by @ashketchum in https://github.com/PokemonCenter/pikabot/pull/154
* feat: implement milk steamer by @ashketchum in https://github.com/PokemonCenter/pikabot/pull/155
### Bug Fixes 🔧
* fix: prevent Pikachu from shocking the coffee machine by @brockharrison in https://github.com/PokemonCenter/pikabot/pull/152
### Training Updates 🎯
* chore: update Pikachu's daily exercise routine by @mistyjoy in https://github.com/PokemonCenter/pikabot/pull/153

**Full Changelog**: https://github.com/PokemonCenter/pikabot/compare/v0.9.9...v1.0.0`
    }
  }
}

// Mock PR responses
const mockPRs: Record<string, { title: string; body: string }> = {
  'https://github.com/PokemonCenter/pikabot/pull/151': {
    title: 'feat: teach Pikachu to make coffee',
    body: `### Summary
Trained Pikachu to operate the coffee machine safely.

### What Changed?
- Added basic barista training program
- Implemented static discharge safety protocols
- Configured optimal voltage for milk steaming

### Why?
Team Rocket keeps stealing our coffee machine, so we're teaching Pikachu to make coffee for the team.

### Issue Link
- jira: VP-123`
  },
  'https://github.com/PokemonCenter/pikabot/pull/152': {
    title: 'fix: prevent Pikachu from shocking the coffee machine',
    body: `### Summary
Implemented safety measures to prevent electrical accidents.

### What Changed?
- Added rubber insulation to machine handles
- Installed surge protectors
- Created emergency power-off switch
- Added "no thunderbolt" warning signs

### Why?
We've gone through 3 coffee machines this week due to static discharge incidents.

### Issue Link
- jira: VP-657`
  },
  'https://github.com/PokemonCenter/pikabot/pull/153': {
    title: "chore: update Pikachu's daily exercise routine",
    body: `### Summary
Modified training schedule to include coffee breaks.

### Issue Link
- jira: VP-789`
  },
  'https://github.com/PokemonCenter/pikabot/pull/154': {
    title: 'feat: implement coffee grinder',
    body: `### Summary
Added coffee grinder functionality.

### Issue Link
- jira: VP-124`
  },
  'https://github.com/PokemonCenter/pikabot/pull/155': {
    title: 'feat: implement milk steamer',
    body: `### Summary
Added milk steamer functionality.

### Issue Link
- jira: VP-125`
  }
}

interface MockJiraIssue {
  fields: {
    issuetype: { subtask: boolean }
    fixVersions: Array<{ name: string }>
    parent: { key: string } | null
  }
}

// Mock Jira responses
const mockJiraIssues: Record<string, MockJiraIssue> = {
  'VP-123': {
    fields: {
      issuetype: { subtask: false },
      fixVersions: [],
      parent: null
    }
  },
  'VP-657': {
    fields: {
      issuetype: { subtask: false },
      fixVersions: [],
      parent: null
    }
  },
  'VP-789': {
    fields: {
      issuetype: { subtask: false },
      fixVersions: [],
      parent: null
    }
  },
  'VP-124': {
    fields: {
      issuetype: { subtask: true },
      fixVersions: [],
      parent: { key: 'VP-123' }
    }
  },
  'VP-125': {
    fields: {
      issuetype: { subtask: true },
      fixVersions: [],
      parent: { key: 'VP-123' }
    }
  }
}

describe('Issue Class', () => {
  it('creates an issue with correct properties', () => {
    const issue = new Issue('ABC-123', false, ['1.0.0'], 'ABC-100')
    expect(issue.key).toBe('ABC-123')
    expect(issue.project).toBe('ABC')
    expect(issue.isSubtask).toBe(false)
    expect(issue.fixVersions).toEqual(['1.0.0'])
    expect(issue.parentKey).toBe('ABC-100')
    expect(issue.parentProject).toBe('ABC')
  })

  it('handles issue without parent', () => {
    const issue = new Issue('ABC-123', false, ['1.0.0'])
    expect(issue.parentKey).toBeUndefined()
    expect(issue.parentProject).toBeUndefined()
  })
})

describe('getJiraVersionName', () => {
  it('extracts version from tag with v prefix', () => {
    expect(getJiraVersionName('v1.2.3')).toBe('1.2.3')
  })

  it('extracts version from tag without v prefix', () => {
    expect(getJiraVersionName('1.2.3')).toBe('1.2.3')
  })

  it('adds custom prefix when provided', () => {
    expect(getJiraVersionName('v1.2.3', 'Release')).toBe('Release 1.2.3')
  })

  it('returns null for invalid version format', () => {
    expect(getJiraVersionName('invalid')).toBeNull()
    expect(getJiraVersionName('v1.2')).toBeNull()
    expect(getJiraVersionName('1.2')).toBeNull()
  })
})

describe('getPullRequestInfo', () => {
  const mockOctokit = {
    rest: {
      pulls: {
        get: vi.fn()
      }
    }
  } as any

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('extracts PR info successfully', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: {
        title: 'Test PR',
        body: 'Test body'
      }
    })

    const result = await getPullRequestInfo(
      mockOctokit,
      'https://github.com/owner/repo/pull/123'
    )

    expect(result).toEqual({
      title: 'Test PR',
      body: 'Test body'
    })
    expect(mockOctokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 123
    })
  })

  it('returns null for invalid PR URL', async () => {
    const result = await getPullRequestInfo(
      mockOctokit,
      'https://invalid-url.com'
    )
    expect(result).toBeNull()
  })

  it('returns null when PR not found', async () => {
    mockOctokit.rest.pulls.get.mockRejectedValue(new Error('Not found'))
    const result = await getPullRequestInfo(
      mockOctokit,
      'https://github.com/owner/repo/pull/123'
    )
    expect(result).toBeNull()
  })

  it('returns null when PR data is null', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({ data: null })
    const result = await getPullRequestInfo(
      mockOctokit,
      'https://github.com/owner/repo/pull/123'
    )
    expect(result).toBeNull()
  })

  it('handles network errors when fetching PR', async () => {
    vi.spyOn(core, 'warning').mockImplementation(() => {})
    mockOctokit.rest.pulls.get.mockRejectedValue(new Error('Network error'))

    const result = await getPullRequestInfo(
      mockOctokit,
      'https://github.com/owner/repo/pull/123'
    )

    expect(result).toBeNull()
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch PR info')
    )
  })
})

describe('extractJiraIssueKeys', () => {
  const mockOctokit = {
    rest: {
      pulls: {
        get: vi.fn()
      }
    }
  } as any

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('extracts issue keys from text and PRs', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: {
        title: '[ABC-123] Test PR',
        body: 'Related to ABC-456'
      }
    })

    const text = `
      Release notes ABC-789
      PR: https://github.com/owner/repo/pull/1
    `

    const result = await extractJiraIssueKeys(text, 'ABC', mockOctokit)
    expect(result).toEqual(['ABC-123', 'ABC-456', 'ABC-789'])
  })

  it('handles duplicate issue keys', async () => {
    mockOctokit.rest.pulls.get.mockResolvedValue({
      data: {
        title: '[ABC-123] Test',
        body: 'ABC-123 duplicate'
      }
    })

    const text = 'ABC-123 in notes'
    const result = await extractJiraIssueKeys(text, 'ABC', mockOctokit)
    expect(result).toEqual(['ABC-123'])
  })

  it('handles failed PR info fetches', async () => {
    vi.spyOn(core, 'warning').mockImplementation(() => {})
    mockOctokit.rest.pulls.get.mockRejectedValue(new Error('Failed to fetch'))

    const text = `
      Release notes
      PR: https://github.com/owner/repo/pull/1
      PR: https://github.com/owner/repo/pull/2
    `

    const result = await extractJiraIssueKeys(text, 'ABC', mockOctokit)
    expect(result).toEqual([])
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Skipping PR due to missing info')
    )
  })
})

describe('validateAndFilterIssues', () => {
  const mockJira = {
    getIssue: vi.fn()
  } as any

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('filters out issues based on criteria', async () => {
    mockJira.getIssue
      .mockResolvedValueOnce(new Issue('ABC-1', false, [], undefined))
      .mockResolvedValueOnce(new Issue('ABC-2', true, [], 'ABC-1'))
      .mockResolvedValueOnce(new Issue('ABC-3', false, ['1.0.0'], undefined))

    const result = await validateAndFilterIssues(
      mockJira,
      ['ABC-1', 'ABC-2', 'ABC-3'],
      '1.0.0',
      true,
      false
    )

    expect(result.map(i => i.key)).toEqual(['ABC-1'])
  })

  it('handles failed issue fetches', async () => {
    mockJira.getIssue
      .mockResolvedValueOnce(new Issue('ABC-1', false, [], undefined))
      .mockRejectedValueOnce(new Error('Failed'))

    const result = await validateAndFilterIssues(
      mockJira,
      ['ABC-1', 'ABC-2'],
      '1.0.0',
      false,
      false
    )

    expect(result.map(i => i.key)).toEqual(['ABC-1'])
  })
})

describe('JiraClient', () => {
  let jiraClient: JiraClient

  beforeEach(() => {
    jiraClient = new JiraClient('example', 'test@example.com', 'token', 'ABC')
    vi.clearAllMocks()
  })

  it('creates version successfully', async () => {
    mockPost.mockResolvedValue({})
    await jiraClient.createVersion('1.0.0')
    expect(mockPost).toHaveBeenCalled()
  })

  it('releases version successfully', async () => {
    mockPut.mockResolvedValue({})
    await jiraClient.releaseVersion('1.0.0', true)
    expect(mockPut).toHaveBeenCalled()
  })

  it('when release false, does not call release update ', async () => {
    mockPut.mockResolvedValue({})
    await jiraClient.releaseVersion('1.0.0', false)
    expect(mockPut).not.toHaveBeenCalled()
  })

  it('handles version creation error', async () => {
    vi.spyOn(core, 'info').mockImplementation(() => {})
    const mockError = new Error('API Error')
    mockPost.mockRejectedValue(mockError)

    await jiraClient.createVersion('1.0.0')

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('Failed to create version 1.0.0')
    )
  })

  it('adds version to issue successfully', async () => {
    mockPut.mockResolvedValue({})
    await jiraClient.addVersion('ABC-123', '1.0.0')
    expect(mockPut).toHaveBeenCalled()
  })
})

describe('Jira Release Action', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Reset GitHub context
    Object.defineProperty(github, 'context', { value: mockContext })

    // Mock core functions
    vi.mocked(core.getInput).mockImplementation((name: string): string => {
      switch (name) {
        case 'github-token':
          return 'mock-token'
        case 'jira-host':
          return 'example'
        case 'jira-email':
          return 'test@example.com'
        case 'jira-token':
          return 'mock-jira-token'
        case 'project-prefix':
          return 'VP'
        case 'skip-subtask':
          return 'false'
        case 'skip-child':
          return 'false'
        default:
          return ''
      }
    })

    // Mock Octokit
    const mockOctokit = {
      rest: {
        pulls: {
          get: vi
            .fn()
            .mockImplementation(async ({ owner, repo, pull_number }) => {
              const prUrl = `https://github.com/${owner}/${repo}/pull/${pull_number}`
              core.debug(`Fetching PR info for ${prUrl}`)
              const pr = mockPRs[prUrl]
              if (!pr) {
                core.warning(`PR not found: ${prUrl}`)
                throw new Error('PR not found')
              }
              return { data: pr }
            })
        }
      }
    }
    vi.mocked(github.getOctokit).mockReturnValue(mockOctokit as any)

    // Mock got responses
    mockGet.mockImplementation(url => {
      if (url.includes('/issue/')) {
        const issueKey = url.split('/').pop()
        if (!issueKey) throw new Error('Invalid URL')
        const issue = mockJiraIssues[issueKey]
        if (!issue) throw new Error('Issue not found')
        return Promise.resolve({
          json: async () => ({
            fields: {
              ...issue.fields,
              issuetype: { ...issue.fields.issuetype },
              fixVersions: [...issue.fields.fixVersions],
              parent: issue.fields.parent ? { ...issue.fields.parent } : null
            }
          })
        })
      }
      if (url.includes('/versions')) {
        return Promise.resolve({ json: async () => [] })
      }
      return Promise.resolve({ json: async () => ({}) })
    })

    mockPost.mockImplementation(() =>
      Promise.resolve({ json: async () => ({}) })
    )
    mockPut.mockImplementation(() =>
      Promise.resolve({ json: async () => ({}) })
    )
  })

  it('extracts Jira issues from PR title and description', async () => {
    await run()
    expect(core.setOutput).toHaveBeenCalledWith(
      'jira_issue_keys',
      expect.arrayContaining(['VP-123', 'VP-657', 'VP-789'])
    )
  })

  it('skips already fixed versions', async () => {
    mockJiraIssues['VP-123'].fields.fixVersions = [{ name: 'v0.0.15' }]
    await run()
    expect(core.setOutput).toHaveBeenCalledWith(
      'jira_issue_keys',
      expect.arrayContaining(['VP-657', 'VP-789'])
    )
  })

  it('skips subtasks when configured', async () => {
    vi.spyOn(core, 'getInput').mockImplementation((name: string) => {
      if (name === 'skip-subtask') return 'true'
      if (name === 'project-prefix') return 'VP'
      return ''
    })

    // Add subtasks to the release notes
    const releaseWithSubtasks = {
      ...mockContext.payload.release,
      body: mockContext.payload.release.body
    }
    Object.defineProperty(github, 'context', {
      value: {
        ...mockContext,
        payload: { release: releaseWithSubtasks }
      }
    })

    await run()
    expect(core.setOutput).toHaveBeenCalledWith(
      'jira_issue_keys',
      expect.arrayContaining(['VP-657', 'VP-789'])
    )
  })

  it('handles missing release payload', async () => {
    Object.defineProperty(github, 'context', {
      value: { ...mockContext, payload: {} }
    })
    await run()
    expect(core.setFailed).toHaveBeenCalledWith(
      'No release data found in the event payload'
    )
  })

  it('handles invalid version name', async () => {
    Object.defineProperty(github, 'context', {
      value: {
        ...mockContext,
        payload: { release: { tag_name: 'invalid', body: '' } }
      }
    })
    await run()
    expect(core.setFailed).toHaveBeenCalledWith(
      'Could not determine version name from release tag'
    )
  })

  it('handles no Jira issues found', async () => {
    Object.defineProperty(github, 'context', {
      value: {
        ...mockContext,
        payload: {
          release: {
            ...mockContext.payload.release,
            body: 'No Jira issues here'
          }
        }
      }
    })

    await run()
    expect(core.info).toHaveBeenCalledWith(
      'No Jira issues found in release notes or PRs'
    )
  })

  it('handles failed version updates', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockPut.mockRejectedValue(new Error('Failed to update version'))

    await run()
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to update version for')
    )
    expect(core.setOutput).toHaveBeenCalledWith(
      'fail_jira_issue_keys',
      expect.any(Array)
    )
  })

  it('handles Jira API errors gracefully', async () => {
    mockGet.mockRejectedValue(new Error('Jira API error'))
    mockPost.mockRejectedValue(new Error('Jira API error'))
    mockPut.mockRejectedValue(new Error('Jira API error'))
  })
})
