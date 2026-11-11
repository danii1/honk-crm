import { CalendarPlus, FilePlus2, MessageSquarePlus, NotebookPen, Plus, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { api, listChannels, type ChannelDef, type ContactDetail } from "@/client/lib/api";
import { STAGES } from "@/client/lib/constants";
import { titleCase } from "@/client/lib/utils";
import { Button } from "./ui/button";
import { RecordFormDialog, type FormField } from "./record-form-dialog";

const fallbackChannels = ["email", "linkedin", "x", "reddit", "threads"].map((id) => ({ id, label: titleCase(id) }));
const timestamp = (value: string) => value ? new Date(value).toISOString() : undefined;
const filled = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()]));
const action = (label: string, Icon: typeof Plus) => <Button variant="outline" size="sm"><Icon className="size-4" /> {label}</Button>;

export function ContactActions({ contact, onSaved }: { contact: ContactDetail; onSaved: () => void }) {
  const [channels, setChannels] = useState<{ id: string; label: string }[]>(fallbackChannels);
  useEffect(() => {
    listChannels().then((result) => setChannels(result.channels.map((channel: ChannelDef) => ({ id: channel.id, label: channel.label })))).catch(() => undefined);
  }, []);
  const channelField: FormField = { name: "channel", label: "Channel", type: "select", required: true, value: "email", options: channels.map((channel) => ({ value: channel.id, label: channel.label })) };

  return <div className="mb-4 flex flex-wrap gap-2" aria-label="Add contact information">
    <RecordFormDialog trigger={action("Add note", NotebookPen)} title="Add a note" description={`Keep a dated note on ${contact.name ?? "this person"}.`}
      fields={[{ name: "body", label: "Note", type: "textarea", required: true, full: true }]}
      onSave={(v) => api("add_note", { entity_id: contact.id, body: (v.body ?? "").trim() })} onSaved={onSaved} submitLabel="Add note" />
    <RecordFormDialog trigger={action("Add task", CalendarPlus)} title="Add a task" description="Give this relationship a concrete next step."
      fields={[{ name: "title", label: "Task", required: true, full: true }, { name: "due_at", label: "Due", type: "datetime-local", full: true }]}
      onSave={(v) => api("create_task", { contact_id: contact.id, title: (v.title ?? "").trim(), ...(v.due_at && { due_at: timestamp(v.due_at) }) })}
      onSaved={onSaved} submitLabel="Add task" />
    <RecordFormDialog trigger={action("Log touch", Send)} title="Log a touch" description="Record an interaction that happened outside Honk."
      fields={[channelField,
        { name: "direction", label: "Direction", type: "select", value: "outbound", options: [{ value: "outbound", label: "Outbound" }, { value: "inbound", label: "Inbound" }] },
        { name: "status", label: "Status", type: "select", value: "sent", options: ["sent", "replied", "bounced", "draft"].map((value) => ({ value, label: titleCase(value) })) },
        { name: "sent_at", label: "When", type: "datetime-local" },
        { name: "subject", label: "Subject", full: true },
        { name: "body", label: "What happened", type: "textarea", full: true },
        { name: "next_followup_at", label: "Follow up", type: "datetime-local", full: true },
      ]}
      onSave={(v) => api("log_touch", { contact_id: contact.id, ...filled(v), ...(v.sent_at && { sent_at: timestamp(v.sent_at) }), ...(v.next_followup_at && { next_followup_at: timestamp(v.next_followup_at) }) })}
      onSaved={onSaved} submitLabel="Log touch" />
    <RecordFormDialog trigger={action("Record reply", MessageSquarePlus)} title="Record a reply" description="Add an inbound event to the contact timeline and Today view."
      fields={[channelField,
        { name: "type", label: "Reply type", type: "select", value: "reply_received", options: [{ value: "reply_received", label: "Reply received" }, { value: "email_reply", label: "Email reply" }, { value: "connection_accepted", label: "Connection accepted" }, { value: "meeting_booked", label: "Meeting booked" }] },
        { name: "occurred_at", label: "When", type: "datetime-local" },
        { name: "summary", label: "Summary", type: "textarea", required: true, full: true },
      ]}
      onSave={(v) => api("record_event", { contact_id: contact.id, channel: v.channel, type: v.type, external_id: `manual-${crypto.randomUUID()}`, summary: (v.summary ?? "").trim(), ...(v.occurred_at && { occurred_at: timestamp(v.occurred_at) }) })}
      onSaved={onSaved} submitLabel="Record reply" />
    <RecordFormDialog trigger={action("Create draft", FilePlus2)} title="Create a draft" description="Write a message for review. Honk will not send it."
      fields={[channelField, { name: "text", label: "Message", type: "textarea", required: true, full: true }, { name: "intent_url", label: "Intent URL", type: "url", full: true, help: "Optional link to open the message in its channel." }]}
      onSave={(v) => api("create_draft", { contact_id: contact.id, channel: v.channel, text: (v.text ?? "").trim(), ...(v.intent_url && { intent_url: v.intent_url.trim() }) })}
      onSaved={onSaved} submitLabel="Create draft" />
    <RecordFormDialog trigger={action("Set follow-up", Plus)} title="Set channel follow-up" description="Set the stage and next step for one channel."
      fields={[channelField,
        { name: "stage", label: "Channel stage", type: "select", options: [{ value: "", label: "Keep current stage" }, ...STAGES.map((value) => ({ value, label: titleCase(value) }))] },
        { name: "next_followup_at", label: "Follow up", type: "datetime-local" },
        { name: "next_step", label: "Next step", full: true, placeholder: "Send a short follow-up" },
      ]}
      onSave={(v) => api("set_channel_state", { contact_id: contact.id, channel: v.channel, ...(v.stage && { stage: v.stage }), ...(v.next_followup_at && { next_followup_at: timestamp(v.next_followup_at) }), ...(v.next_step && { next_step: v.next_step.trim() }) })}
      onSaved={onSaved} submitLabel="Save follow-up" />
  </div>;
}
