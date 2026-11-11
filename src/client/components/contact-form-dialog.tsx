import { useEffect, useState, type ReactNode } from "react";
import { api, listCampaigns, type Contact } from "@/client/lib/api";
import { STAGES } from "@/client/lib/constants";
import { titleCase } from "@/client/lib/utils";
import { RecordFormDialog, type FormField } from "./record-form-dialog";

export function ContactFormDialog({ trigger, contact, defaultStage = "new", onSaved }: {
  trigger: ReactNode;
  contact?: Contact;
  defaultStage?: string;
  onSaved?: (contact: Contact) => void;
}) {
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { listCampaigns().then(setCampaigns).catch(() => undefined); }, []);
  const fields: FormField[] = [
    { name: "name", label: "Name", value: contact?.name, required: !contact },
    { name: "email", label: "Email", type: "email", value: contact?.email },
    { name: "role", label: "Role", value: contact?.role, placeholder: "Founder, Head of Growth…" },
    { name: "company_name", label: "Company name", value: contact?.company?.name, readOnly: !!contact, help: contact ? "Edit company details on the Companies page." : undefined },
    { name: "company_domain", label: "Company domain", value: contact?.company?.domain, placeholder: "example.com" },
    ...(contact?.companyId ? [{ name: "company_link", label: "Company link", type: "select" as const, value: "keep", options: [{ value: "keep", label: "Keep linked" }, { value: "remove", label: "Remove from this person" }] }] : []),
    ...(!contact ? [{ name: "stage", label: "Stage", type: "select" as const, value: defaultStage, options: STAGES.map((stage) => ({ value: stage, label: titleCase(stage) })) }] : []),
    { name: "campaign_id", label: "Campaign", type: "select", value: contact?.campaignId, options: [{ value: "", label: "No campaign" }, ...(contact?.campaignId && !campaigns.some((campaign) => campaign.id === contact.campaignId) ? [{ value: contact.campaignId, label: "Current campaign" }] : []), ...campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }))] },
    { name: "source", label: "Source", value: contact?.source ?? (!contact ? "other" : ""), placeholder: "other, web, linkedin…" },
    { name: "source_detail", label: "Source detail", value: contact?.sourceDetail },
    { name: "score", label: "Score", type: "number", min: 1, max: 5, value: contact?.score },
    { name: "followers", label: "Followers", type: "number", min: 0, value: contact?.followers },
    { name: "est_team_size", label: "Estimated team size", type: "number", min: 0, value: contact?.estTeamSize },
    { name: "x_handle", label: "X handle", value: contact?.xHandle, placeholder: "@handle" },
    { name: "linkedin_url", label: "LinkedIn", value: contact?.linkedin, placeholder: "linkedin.com/in/name" },
    { name: "reddit_user", label: "Reddit", value: contact?.redditUser, placeholder: "u/name" },
    { name: "github", label: "GitHub", value: contact?.github, placeholder: "username" },
    { name: "threads_handle", label: "Threads", value: contact?.threadsHandle, placeholder: "@handle" },
    { name: "website", label: "Website", value: contact?.website, placeholder: "https://example.com" },
    { name: "profile_url", label: "Original profile URL", value: contact?.profileUrl, full: true },
    { name: "signal_post_url", label: "Signal post URL", type: "url", value: contact?.signalPostUrl, full: true },
    { name: "signal_date", label: "Signal date", type: "date", value: contact?.signalDate?.slice(0, 10) },
    { name: "signal_summary", label: "Signal summary", type: "textarea", value: contact?.signalSummary, full: true },
    { name: "bio_summary", label: "Background", type: "textarea", value: contact?.bioSummary, full: true },
    { name: "notes", label: "Reference notes", type: "textarea", value: contact?.notesText, full: true, help: "Use Add note on the detail page for dated notes." },
    { name: "tags", label: "Add tags", value: "", full: true, placeholder: "priority, conference", help: "Comma-separated. Existing tags stay attached." },
  ];

  return <RecordFormDialog
    trigger={trigger}
    title={contact ? "Edit person" : "Add person"}
    description={contact ? "Update their profile and linked identities." : "Start with a name, then add any details you have. Honk checks identities for duplicates."}
    fields={fields}
    submitLabel={contact ? "Save changes" : "Add person"}
    onSave={async (values) => {
      const clear: string[] = [];
      if (contact) {
        const previous: Record<string, unknown> = {
          name: contact.name, email: contact.email, role: contact.role, source: contact.source, source_detail: contact.sourceDetail,
          x_handle: contact.xHandle, linkedin_url: contact.linkedin, reddit_user: contact.redditUser,
          github: contact.github, threads_handle: contact.threadsHandle, website: contact.website,
          bio_summary: contact.bioSummary, notes: contact.notesText, score: contact.score,
          followers: contact.followers, est_team_size: contact.estTeamSize,
          signal_post_url: contact.signalPostUrl, signal_date: contact.signalDate, signal_summary: contact.signalSummary,
          profile_url: contact.profileUrl, campaign_id: contact.campaignId,
        };
        for (const [key, old] of Object.entries(previous)) {
          if (old !== null && old !== undefined && old !== "" && !values[key]?.trim()) clear.push(key);
        }
        if (contact.companyId && values.company_link === "remove") clear.push("company_id");
      }
      const body: Record<string, unknown> = {
        ...(contact ? { contact_id: contact.id } : {}),
        ...(clear.length ? { clear } : {}),
      };
      for (const key of ["name", "email", "role", "source", "source_detail", "x_handle", "linkedin_url", "reddit_user", "github", "threads_handle", "website", "profile_url", "signal_post_url", "signal_date", "signal_summary", "bio_summary", "notes", "stage", "campaign_id"]) {
        if (values[key]?.trim()) body[key] = values[key].trim();
      }
      if (values.company_link !== "remove") {
        if (!contact && values.company_name?.trim()) body.company_name = values.company_name.trim();
        if (values.company_domain?.trim()) body.company_domain = values.company_domain.trim();
      }
      if (values.score) body.score = Number(values.score);
      for (const key of ["followers", "est_team_size"]) if (values[key] !== "" && values[key] !== undefined) body[key] = Number(values[key]);
      if (values.tags?.trim()) body.tags = values.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
      return api<{ contact: Contact }>("upsert_contact", body);
    }}
    onSaved={(result) => onSaved?.((result as { contact: Contact }).contact)}
  />;
}
