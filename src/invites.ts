/**
 * Pluggable invitation delivery. The CRM never sends email itself: by default the sender just logs the
 * accept URL (dev). Swap in a real sender (Resend, SES, ...) with setInviteSender() at startup.
 */
export interface InviteMessage {
  invitationId: string;
  email: string;
  role: string;
  organization: { id: string; name: string };
  inviter: { id?: string; name?: string; email?: string };
  acceptUrl: string;
  expiresAt: Date;
}
export type InviteSender = (msg: InviteMessage) => Promise<void> | void;

const logSender: InviteSender = (m) => {
  console.log(`[invite] ${m.email} -> ${m.organization.name} as ${m.role}: ${m.acceptUrl}`);
};
let sender: InviteSender = logSender;
export const setInviteSender = (s: InviteSender | null) => {
  sender = s ?? logSender;
};
export const deliverInvite = (m: InviteMessage) => sender(m);
export const acceptUrl = (baseURL: string, token: string) => `${baseURL.replace(/\/$/, "")}/accept-invite?token=${encodeURIComponent(token)}`;
