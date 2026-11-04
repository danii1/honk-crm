export const STAGES = [
  "new",
  "qualified",
  "drafted",
  "contacted",
  "connection_pending",
  "connected",
  "responded",
  "call_booked",
  "pilot",
  "paying",
  "lost",
  "do_not_contact",
] as const;

export const LEAD_STAGES = ["new", "qualified", "drafted", "contacted", "connection_pending", "connected"] as const;
export const CONTACT_STAGES = ["responded", "call_booked", "pilot", "paying"] as const;
export const ARCHIVED_STAGES = ["lost", "do_not_contact"] as const;
