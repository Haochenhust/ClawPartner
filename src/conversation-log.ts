import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

/**
 * Append a formatted conversation entry to the group's daily log file.
 * Format: [HH:MM] SenderName: text
 *
 * The timestamp must be an ISO 8601 UTC string; it is converted to
 * Beijing time (UTC+8) before writing.
 */
export function appendConversationLog(
  conversationsDir: string,
  senderName: string,
  text: string,
  timestamp: string,
): void {
  try {
    const dailyDir = path.join(conversationsDir, 'daily');
    fs.mkdirSync(dailyDir, { recursive: true });
    // Convert UTC timestamp to Beijing time (UTC+8) for log display
    const d = new Date(timestamp);
    const beijingIso = new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString();
    const date = beijingIso.slice(0, 10); // YYYY-MM-DD
    const time = beijingIso.slice(11, 16); // HH:MM
    const filePath = path.join(dailyDir, `${date}.md`);
    const entry = `[${time}] ${senderName}: ${text}\n`;
    fs.appendFileSync(filePath, entry, 'utf8');
  } catch (err) {
    logger.warn({ conversationsDir, err }, 'appendConversationLog failed');
  }
}
