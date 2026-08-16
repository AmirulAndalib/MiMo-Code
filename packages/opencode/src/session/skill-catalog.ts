export const SKILL_CATALOG_REMINDER_MARKER = "Skills available in this session:"

export function isSkillCatalogReminder(text: string) {
  return text.includes(SKILL_CATALOG_REMINDER_MARKER)
}
