import * as core from '@actions/core'
import * as github from '@actions/github'
import ky from 'ky'

export class Issue {
  readonly key: string
  readonly project: string
  readonly isSubtask: boolean
  readonly fixVersions: string[]
  readonly parentKey?: string
  readonly parentProject?: string

  constructor(
    key: string,
    isSubtask: boolean,
    fixVersions: string[],
    parentKey?: string
  ) {
    this.key = key
    this.project = key.split('-')[0]
    this.isSubtask = isSubtask
    this.fixVersions = fixVersions
    this.parentKey = parentKey
    this.parentProject = parentKey?.split('-')[0]
  }
}

export class JiraClient {
  private client: typeof ky
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
    this.client = ky.create({
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
      console.info(`Created version: ${versionName}`)
      core.info(`Created version: ${versionName}`)
    } catch (error) {
      // Version might already exist, which is fine
      console.debug(
        `Failed to create version ${versionName}, it might already exist: ${error}`
      )
      core.debug(
        `Failed to create version ${versionName}, it might already exist: ${error}`
      )
    }
  }

  async releaseVersion(versionName: string): Promise<void> {
    try {
      console.debug(`Finding version ${versionName}`)
      // Find version ID first
      const response = await this.client
        .get(`${this.baseUrl}/project/${this.projectKey}/versions`)
        .json<any>()
      console.debug(`Found version`, response)
      const version = response.find((v: any) => v.name === versionName)
      if (!version) {
        throw new Error(`Version ${versionName} not found`)
      }

      // Update version to released state
      await this.client.put(`${this.baseUrl}/version/${version.id}`, {
        json: {
          released: true
        }
      })
      console.info(`Released version: ${versionName}`)
      core.info(`Released version: ${versionName}`)
    } catch (error) {
      console.warn(`Failed to release version ${versionName}: ${error}`)
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
}

export function getJiraVersionName(
  branchName: string,
  prefix?: string
): string | null {
  const regex = /v?(\d+\.\d+\.\d+)/
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
    console.warn(`Invalid PR URL format: ${prUrl}`)
    core.warning(`Invalid PR URL format: ${prUrl}`)
    return null
  }

  const [, owner, repo, pullNumber] = match
  const number = parseInt(pullNumber, 10)

  try {
    console.debug(`Fetching PR info for ${owner}/${repo}#${number}`)
    core.debug(`Fetching PR info for ${owner}/${repo}#${number}`)
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: number
    })

    if (!pr) {
      console.warn(`PR not found: ${prUrl}`)
      core.warning(`PR not found: ${prUrl}`)
      return null
    }

    console.debug(`Found PR: ${pr.title}`)
    core.debug(`Found PR: ${pr.title}`)
    return {
      title: pr.title,
      body: pr.body || ''
    }
  } catch (error) {
    console.warn(`Failed to fetch PR info for ${prUrl}: ${error}`)
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
    console.debug(`Found issue key in release notes: ${match}`)
    core.debug(`Found issue key in release notes: ${match}`)
    issueSet.add(match)
  })

  // Then check each PR
  for (const prUrl of prUrls) {
    console.debug(`Processing PR: ${prUrl}`)
    core.debug(`Processing PR: ${prUrl}`)
    const prInfo = await getPullRequestInfo(octokit, prUrl)
    if (!prInfo) {
      console.warn(`Skipping PR due to missing info: ${prUrl}`)
      core.warning(`Skipping PR due to missing info: ${prUrl}`)
      continue
    }

    // Check PR title and description for Jira issue keys
    const titleMatches = prInfo.title.match(jiraRegex) || []
    const bodyMatches = prInfo.body.match(jiraRegex) || []

    // Add all matches to the set
    titleMatches.forEach(match => {
      console.debug(`Found issue key in PR title: ${match}`)
      core.debug(`Found issue key in PR title: ${match}`)
      issueSet.add(match)
    })
    bodyMatches.forEach(match => {
      console.debug(`Found issue key in PR body: ${match}`)
      core.debug(`Found issue key in PR body: ${match}`)
      issueSet.add(match)
    })
  }

  const result = [...issueSet].sort()
  console.info(`Found Jira issues: ${result.join(', ')}`)
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
        console.warn(`Failed to get issue ${key}: ${e.message}`)
        core.warning(`Failed to get issue ${key}: ${e.message}`)
        return Promise.resolve(new Issue('', false, []))
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

    console.info(`Processing version: ${versionName}`)
    core.info(`Processing version: ${versionName}`)

    // Extract Jira issues from release body and PRs
    const issueKeys = await extractJiraIssueKeys(
      release.body,
      projectPrefix,
      octokit
    )
    if (issueKeys.length === 0) {
      console.info('No Jira issues found in release notes or PRs')
      core.info('No Jira issues found in release notes or PRs')
      return
    }

    console.info(`Found Jira issues: ${issueKeys.join(', ')}`)
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

    // Update issues with the new version
    const failedIssues: string[] = []
    for (const issue of issues) {
      try {
        await jira.addVersion(issue.key, versionName)
        console.info(`Updated version for ${issue.key}`)
        core.info(`Updated version for ${issue.key}`)
      } catch (error) {
        console.warn(`Failed to update version for ${issue.key}: ${error}`)
        core.warning(`Failed to update version for ${issue.key}: ${error}`)
        failedIssues.push(issue.key)
      }
    }

    // Release the version after all issues are updated
    await jira.releaseVersion(versionName)

    // Set outputs
    core.setOutput(
      'jira_issue_keys',
      issues.map(i => i.key)
    )
    core.setOutput('fail_jira_issue_keys', failedIssues)

    if (failedIssues.length > 0) {
      console.warn(`Failed to update some issues: ${failedIssues.join(', ')}`)
      core.warning(`Failed to update some issues: ${failedIssues.join(', ')}`)
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message)
      core.setFailed(error.message)
    }
  }
}
