/** A workflow scope retains its workflow version ID and existing integrations. */
export type QuestionnaireScope = string | SkillQuestionnaireScope;

export interface SkillQuestionnaireScope {
  id: string;
  skillId: string;
  versionHash: string;
  groupId: string;
}

export function questionnaireScopeId(scope: QuestionnaireScope) {
  return typeof scope === "string" ? scope : scope.id;
}

export function questionnaireOwners(scope: QuestionnaireScope) {
  return typeof scope === "string" ? [scope, null] : [null, scope.id];
}
