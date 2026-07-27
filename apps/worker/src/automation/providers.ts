/**
 * Provider port for the Google APIs used by Organization Automation. Business
 * use-cases receive this interface instead of Fetch request/response shapes.
 */
export interface GoogleAutomationPort {
  request<T>(accessToken: string, url: string, init?: RequestInit): Promise<T>;
}

export interface AutomationDependencies {
  google: GoogleAutomationPort;
  attachments: {
    read: typeof readGmailAttachments;
    publish: typeof publishDriveAttachment;
  };
  gemini: {
    extract: typeof extractGeminiEventDetails;
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
    if (!response.ok) throw new Error(body.error?.message ?? 'Google API request failed.');
    return body;
  },
};

/** The only production adapter set used by Organization Automation. */
export const productionAutomationDependencies: AutomationDependencies = {
  google: productionGoogleAutomationPort,
  attachments: { read: readGmailAttachments, publish: publishDriveAttachment },
  gemini: { extract: extractGeminiEventDetails },
  tokens: { refresh: refreshGoogleToken },
};
import { extractGeminiEventDetails } from '../event-details';
import { publishDriveAttachment, readGmailAttachments } from '../drive-attachments';
import { refreshGoogleToken } from '../google';
