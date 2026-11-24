import { Navigate, useParams } from "react-router-dom";
import { skillVersionPath } from "./skills/versionDisplay.js";

export function SourceReviewPage() {
  const { skillId, hash } = useParams();
  return (
    <Navigate
      replace
      to={
        skillId && hash
          ? {
              pathname: skillVersionPath(skillId, hash),
              search: "?tab=effects",
            }
          : "/skills"
      }
    />
  );
}
