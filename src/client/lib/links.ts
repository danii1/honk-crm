import type { Contact, Lifecycle } from "./api";
import { lifecycleOf } from "../../lifecycle";

export function contactHref(contact: { id: string; lifecycle?: Lifecycle | string | null }) {
  return contact.lifecycle === "lead" || !contact.lifecycle ? `/leads/${contact.id}` : `/contacts/${contact.id}`;
}

export function contactHrefById(id: string, lifecycle?: Lifecycle | string | null) {
  return lifecycle === "lead" || !lifecycle ? `/leads/${id}` : `/contacts/${id}`;
}

/** List page for a pipeline stage, staying inside that stage's lifecycle. */
export function stageHref(stage: string) {
  const lifecycle = lifecycleOf(stage);
  if (lifecycle === "archived") return `/contacts?view=archived&stage=${encodeURIComponent(stage)}`;
  return `${lifecycle === "contact" ? "/contacts" : "/leads"}?stage=${encodeURIComponent(stage)}`;
}

export function primaryIdentity(contact: Contact) {
  return contact.identities?.find((i) => !i.private) ?? contact.identities?.[0];
}
