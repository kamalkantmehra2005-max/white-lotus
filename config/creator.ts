/**
 * Creator credit shown in the Admin / Creator section. Public, professional information only —
 * no contact details, no personal data. Override with NEXT_PUBLIC_CREATOR_NAME / NEXT_PUBLIC_CREATOR_ROLE.
 */
export const CREATOR = {
  name: (process.env.NEXT_PUBLIC_CREATOR_NAME || "").trim() || "Kamal Kant",
  role: (process.env.NEXT_PUBLIC_CREATOR_ROLE || "").trim() || "Legal Secretary at Remfry & Sagar",
};
