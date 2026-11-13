/**
 * GitHub Actions download offload.
 *
 * Instead of running yt-dlp on this 0.1-CPU / 512MB host (slow, and it OOMs on
 * long audio), the bot dispatches the `dl.yml` workflow to a strong GitHub
 * runner (2 cores / 7GB) that downloads through WARP (beating the bot-wall) and
 * uploads the file straight to the chat via a user session (up to ~4GB). The
 * workflow also messages the chat on failure, so the user always gets a reply.
 *
 * This module ONLY fires the workflow — all the heavy lifting is in dl.yml.
 * Disabled (returns false) unless GH_DL_TOKEN is configured, so the bot cleanly
 * falls back to the local yt-dlp path (the current working behavior).
 */
import { env } from '../config/env';
import { createLogger } from '../core/logger';

const log = createLogger('github-dl');

/** True when the GitHub offload is configured and should be preferred. */
export function githubDlEnabled(): boolean {
  return Boolean(env.GH_DL_TOKEN && env.GH_DL_REPO && env.GH_DL_WORKFLOW);
}

export interface GithubDlRequest {
  url: string;
  mode: 'audio' | 'video';
  chatId: number | string;
  quality?: string;
}

/**
 * Fire the dl.yml workflow. Returns true if GitHub accepted the dispatch (HTTP
 * 204). Never throws — on any error it returns false so the caller can fall
 * back to a local download.
 */
export async function dispatchGithubDownload(req: GithubDlRequest): Promise<boolean> {
  if (!githubDlEnabled()) return false;
  const repo = env.GH_DL_REPO;
  const workflow = env.GH_DL_WORKFLOW;
  const ref = env.GH_DL_REF;
  const api = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  try {
    const res = await fetch(api, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_DL_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'telegram-bot-dl',
      },
      body: JSON.stringify({
        ref,
        inputs: {
          url: req.url,
          mode: req.mode,
          target: String(req.chatId),
          quality: req.quality ?? '720',
        },
      }),
    });
    if (res.status === 204) {
      log.info({ mode: req.mode }, 'dispatched GitHub download workflow');
      return true;
    }
    const body = await res.text().catch(() => '');
    log.warn({ status: res.status, body: body.slice(0, 200) }, 'GitHub dispatch rejected');
    return false;
  } catch (err) {
    log.warn({ err }, 'GitHub dispatch failed');
    return false;
  }
}
