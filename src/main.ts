import * as core from '@actions/core'
import * as github from '@actions/github'
import got from 'got'

export interface IssueStatus {
  name: string
  id: string
}

export interface IssueComponent {
  name: string
}

export class Issue {
  readonly key: string
  readonly project: string
  readonly isSubtask: boolean
  readonly fixVersions: string[]
  readonly parentKey?: string
  readonly parentProject?: string
  readonly status: IssueStatus
  readonly components: IssueComponent[]

  constructor(
    key: string,
    isSubtask: boolean,
    fixVersions: string[],
    status: IssueStatus,
    components: IssueComponent[],
    parentKey?: string
  ) {
    this.key = key
    this.project = key.split('-')[0]
    this.isSubtask = isSubtask
    this.fixVersions = fixVersions
    this.status = status
    this.components = components
    this.parentKey = parentKey
    this.parentProject = parentKey?.split('-')[0]
  }
}

export class JiraClient {
  private client: typeof got
  private baseUrl: string
  private projectKey: string
  private projectId?: string
  constructor(
    domain: string,
    email: string,
    token: string,
    projectKey: string
  ) {
    this.baseUrl = `https://${domain}/rest/api/3`
    this.projectKey = projectKey
    const auth = Buffer.from(`${email}:${token}`).toString('base64')
    this.client = got.extend({
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    })
  }
  async init(): Promise<void> {
    this.projectId = await this.getProjectId(this.projectKey)
  }

  async getProjectId(projectKey: string): Promise<string> {
    const response = await this.client
      .get(`${this.baseUrl}/project/${projectKey}`)
      .json<{ id: string }>()
    return response.id
  }

  async getIssue(issueKey: string): Promise<Issue> {
    const response = await this.client
      .get(`${this.baseUrl}/issue/${issueKey}`)
      .json<any>()
    const fields = response.fields
    const fixVersions = fields.fixVersions.map(
      (fixVersion: any) => fixVersion.name
    )
    return new Issue(
      issueKey,
      fields.issuetype.subtask,
      fixVersions,
      fields.status,
      fields.components,
      fields.parent?.key
    )
  }

  async createVersion(versionName: string): Promise<void> {
    try {
      await this.client.post(`${this.baseUrl}/version`, {
        json: {
          name: versionName,
          released: false,
          projectId: this.projectId
        }
      })
      core.info(`Created version: ${versionName}`)
    } catch (error) {
      // Version might already exist, which is fine
      core.info(
        `Failed to create version ${versionName}, it might already exist: ${error}`
      )
    }
  }

  async releaseVersion(versionName: string, released: boolean): Promise<void> {
    try {
      // Find version ID first
      const response = await this.client
        .get(`${this.baseUrl}/project/${this.projectKey}/versions`)
        .json<any>()
      // console.debug(`Found versions`, response)
      const version = response.find((v: any) => v.name === versionName)
      if (!version) {
        throw new Error(`Version ${versionName} not found`)
      }

      if (released) {
        // Update version to released state
        await this.client.put(`${this.baseUrl}/version/${version.id}`, {
          json: {
            released: released
          }
        })
      }
      core.info(`Released version: ${versionName}`)
    } catch (error) {
      core.warning(`Failed to release version ${versionName}: ${error}`)
    }
  }

  async addVersion(issueKey: string, versionName: string): Promise<void> {
    await this.client.put(`${this.baseUrl}/issue/${issueKey}`, {
      json: {
        update: {
          fixVersions: [
            {
              add: { name: versionName }
            }
          ]
        }
      }
    })
  }

  async addComponent(issueKey: string, componentName: string): Promise<void> {
    await this.client.put(`${this.baseUrl}/issue/${issueKey}`, {
      json: {
        update: {
          components: [
            {
              add: { name: componentName }
            }
          ]
        }
      }
    })
  }

  async updateStatus(issueKey: string, status: string): Promise<void> {
    // First get available transitions
    const response = await this.client
      .get(`${this.baseUrl}/issue/${issueKey}/transitions`)
      .json<any>()

    const transition = response.transitions.find(
      (t: any) => t.to.name.toLowerCase() === status.toLowerCase()
    )

    if (!transition) {
      throw new Error(
        `Status "${status}" not found in available transitions for ${issueKey}`
      )
    }

    // Perform the transition
    await this.client.post(`${this.baseUrl}/issue/${issueKey}/transitions`, {
      json: {
        transition: {
          id: transition.id
        }
      }
    })
    core.info(`Updated status for ${issueKey} to ${status}`)
  }
}

export function getJiraVersionName(
  branchName: string,
  prefix?: string
): string | null {
  const regex = /(v?\d+\.\d+\.\d+)/
  const matches = regex.exec(branchName)
  if (!matches) return null

  const versionName = matches[1]
  return prefix ? `${prefix} ${versionName}` : versionName
}

export async function getPullRequestInfo(
  octokit: ReturnType<typeof github.getOctokit>,
  prUrl: string
): Promise<{ title: string; body: string } | null> {
  // Extract owner, repo, and PR number from URL
  // Example URL: https://github.com/PokemonCenter/pikabot/pull/151
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!match) {
    core.warning(`Invalid PR URL format: ${prUrl}`)
    return null
  }

  const [, owner, repo, pullNumber] = match
  const number = parseInt(pullNumber, 10)

  try {
    core.debug(`Fetching PR info for ${owner}/${repo}#${number}`)
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: number
    })

    if (!pr) {
      core.warning(`PR not found: ${prUrl}`)
      return null
    }

    core.debug(`Found PR: ${pr.title}`)
    return {
      title: pr.title,
      body: pr.body || ''
    }
  } catch (error) {
    core.warning(`Failed to fetch PR info for ${prUrl}: ${error}`)
    return null
  }
}

export async function extractJiraIssueKeys(
  text: string,
  projectPrefix: string,
  octokit: ReturnType<typeof github.getOctokit>
): Promise<string[]> {
  const prUrlRegex = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/g
  const prUrls = text.match(prUrlRegex) || []

  const issueSet = new Set<string>()
  const jiraRegex = new RegExp(`${projectPrefix}-\\d+`, 'g')

  // First check the release notes itself
  const releaseNoteMatches = text.match(jiraRegex) || []
  releaseNoteMatches.forEach(match => {
    core.debug(`Found issue key in release notes: ${match}`)
    issueSet.add(match)
  })

  // Then check each PR
  for (const prUrl of prUrls) {
    core.debug(`Processing PR: ${prUrl}`)
    const prInfo = await getPullRequestInfo(octokit, prUrl)
    if (!prInfo) {
      core.warning(`Skipping PR due to missing info: ${prUrl}`)
      continue
    }

    // Check PR title and description for Jira issue keys
    const titleMatches = prInfo.title.match(jiraRegex) || []
    const bodyMatches = prInfo.body.match(jiraRegex) || []

    // Add all matches to the set
    titleMatches.forEach(match => {
      core.debug(`Found issue key in PR title: ${match}`)
      issueSet.add(match)
    })
    bodyMatches.forEach(match => {
      core.debug(`Found issue key in PR body: ${match}`)
      issueSet.add(match)
    })
  }

  const result = [...issueSet].sort()
  core.info(`Found Jira issues: ${result.join(', ')}`)
  return result
}

export async function validateAndFilterIssues(
  jira: JiraClient,
  issueKeys: string[],
  versionName: string,
  skipSubtask: boolean,
  skipChild: boolean
): Promise<Issue[]> {
  const issues = await Promise.all(
    issueKeys.map(async key => {
      try {
        return await jira.getIssue(key)
      } catch (e: any) {
        core.warning(`Failed to get issue ${key}: ${e.message}`)
        return Promise.resolve(
          new Issue('', false, [], { name: '', id: '' }, [])
        )
      }
    })
  )

  return issues.filter(issue => {
    if (!issue.key) return false
    if (skipSubtask && issue.isSubtask) return false
    if (skipChild && (issue.parentKey || issue.project === issue.parentProject))
      return false
    if (issue.fixVersions.includes(versionName)) return false
    return true
  })
}

export async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true })
    const jiraToken = core.getInput('jira-token', { required: true })
    const jiraDomain = core.getInput('jira-host', { required: true })
    const projectPrefix = core.getInput('project-prefix', { required: true })
    const versionPrefix = core.getInput('jira-version-prefix')
    const skipSubtask = core.getInput('skip-subtask') === 'true'
    const skipChild = core.getInput('skip-child') === 'true'
    const released = core.getInput('released') === 'true'

    const octokit = github.getOctokit(token)
    const jiraEmail = core.getInput('jira-email', { required: true })
    const jira = new JiraClient(jiraDomain, jiraEmail, jiraToken, projectPrefix)

    // Get release information
    const release = github.context.payload.release
    if (!release) {
      throw new Error('No release data found in the event payload')
    }

    await jira.init()

    const versionName = getJiraVersionName(release.tag_name, versionPrefix)
    if (!versionName) {
      throw new Error('Could not determine version name from release tag')
    }

    core.info(`Processing version: ${versionName}`)

    // Extract Jira issues from release body and PRs
    const issueKeys = await extractJiraIssueKeys(
      release.body,
      projectPrefix,
      octokit
    )
    if (issueKeys.length === 0) {
      core.info('No Jira issues found in release notes or PRs')
      return
    }

    core.info(`Found Jira issues: ${issueKeys.join(', ')}`)

    // Create version first
    await jira.createVersion(versionName)

    // Validate and filter issues
    const issues = await validateAndFilterIssues(
      jira,
      issueKeys,
      versionName,
      skipSubtask,
      skipChild
    )

    // Update issues with the new version, component, and status if specified
    const failedIssues: string[] = []
    const component = core.getInput('component')
    const status = core.getInput('status')

    for (const issue of issues) {
      try {
        await jira.addVersion(issue.key, versionName)
        core.info(`Updated version for ${issue.key}`)

        if (component) {
          await jira.addComponent(issue.key, component)
          core.info(`Added component ${component} to ${issue.key}`)
        }

        if (status) {
          await jira.updateStatus(issue.key, status)
        }
      } catch (error) {
        core.warning(`Failed to update ${issue.key}: ${error}`)
        failedIssues.push(issue.key)
      }
    }

    // Release the version after all issues are updated
    await jira.releaseVersion(versionName, released)

    // Set outputs
    core.setOutput(
      'jira_issue_keys',
      issues.map(i => i.key)
    )
    core.setOutput('fail_jira_issue_keys', failedIssues)

    if (failedIssues.length > 0) {
      core.warning(`Failed to update some issues: ${failedIssues.join(', ')}`)
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}
