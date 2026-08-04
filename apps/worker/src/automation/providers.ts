/**
 * Provider port for the Google APIs used by Organization Automation. Business
 * use-cases receive this interface instead of Fetch request/response shapes.
 */
export interface GoogleAutomationPort {
  request<T>(accessToken: string, url: string, init?: RequestInit): Promise<T>;
}

export class GoogleApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.url = url;
  }
}

export interface AutomationDependencies {
  google: GoogleAutomationPort;
  attachments: {
    read: typeof readGmailAttachments;
    publish: typeof publishDriveAttachment;
    ensurePath: typeof ensureAttachmentFolderPath;
    createMessageFolder: typeof createSourceMessageFolder;
    find: typeof findPublishedDriveAttachment;
  };
  ai: {
    extract: typeof extractAiEventDetails;
    correspond: typeof decideEventCorrespondence;
  };
  agent: {
    complete: typeof completeAgentTurn;
  };
  tokens: {
    refresh: typeof refreshGoogleToken;
  };
}

/** Production adapter for Gmail and Google Calendar. */
export const productionGoogleAutomationPort: GoogleAutomationPort = {
  async request<T>(accessToken: string, url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...init?.headers },
    });
    const body = await response.json() as T & { error?: { message?: string } };
    if (!response.ok) throw new GoogleApiError(body.error?.message ?? 'Google API request failed.', response.status, url);
    return body;
  },
};

/** The only production adapter set used by Organization Automation. */
export const productionAutomationDependencies: AutomationDependencies = {
  google: productionGoogleAutomationPort,
  attachments: {
    read: readGmailAttachments,
    publish: publishDriveAttachment,
    ensurePath: ensureAttachmentFolderPath,
    createMessageFolder: createSourceMessageFolder,
    find: findPublishedDriveAttachment,
  },
  ai: { extract: extractAiEventDetails, correspond: decideEventCorrespondence },
  agent: { complete: completeAgentTurn },
  tokens: { refresh: refreshGoogleToken },
};
import { extractAiEventDetails } from '../event-details';
import { decideEventCorrespondence } from '../event-refresh';
import { completeAgentTurn } from '../agent-runs';
import {
  createSourceMessageFolder,
  ensureAttachmentFolderPath,
  findPublishedDriveAttachment,
  publishDriveAttachment,
  readGmailAttachments,
} from '../drive-attachments';
import { refreshGoogleToken } from '../google';
