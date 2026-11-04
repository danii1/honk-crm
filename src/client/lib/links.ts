import type { Contact, Lifecycle } from "./api";

export function contactHref(contact: { id: string; lifecycle?: Lifecycle | string | null }) {
  return contact.lifecycle === "lead" || !contact.lifecycle ? `/leads/${contact.id}` : `/contacts/${contact.id}`;
}

export function contactHrefById(id: string, lifecycle?: Lifecycle | string | null) {
  return lifecycle === "lead" || !lifecycle ? `/leads/${id}` : `/contacts/${id}`;
}

export function primaryIdentity(contact: Contact) {
  return contact.identities?.find((i) => !i.private) ?? contact.identities?.[0];
}
