import { Alert, Button, Input, Space } from "antd";
import { useState } from "react";
import {
  questionnaireRequest,
  type QuestionComment,
  type QuestionnaireView,
} from "../../api/questionnaire.js";
import { useI18n } from "../../i18n/I18nContext.js";

interface ThreadProps {
  basePath: string;
  path: string;
  questionId: string;
  view: QuestionnaireView;
  onChanged(): void;
}

function Comment({
  comment,
  ...props
}: ThreadProps & { comment: QuestionComment }) {
  const { t, format, locale } = useI18n();
  const [edit, setEdit] = useState<{ text: string; revision: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const save = async () => {
    if (!edit || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await questionnaireRequest(
        props.basePath,
        `${props.path}/comments/${encodeURIComponent(comment.id)}`,
        "PATCH",
        edit,
      );
      setEdit(null);
      props.onChanged();
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : t("questionnaire.failed"),
      );
      props.onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="questionnaire-comment" data-testid="question-comment">
      <h4>{comment.personName}</h4>
      <p className="muted">
        {new Date(comment.createdAt).toLocaleString(locale)}
      </p>
      {failure && <Alert type="error" showIcon message={failure} />}
      {edit ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="field-label" htmlFor={`comment-${comment.id}`}>
            {t("questionnaire.editCommentText")}
          </label>
          <Input.TextArea
            id={`comment-${comment.id}`}
            value={edit.text}
            maxLength={20000}
            autoSize={{ minRows: 3, maxRows: 12 }}
            disabled={busy}
            onChange={(event) => setEdit({ ...edit, text: event.target.value })}
          />
          <Space className="questionnaire-actions" wrap>
            <Button
              htmlType="submit"
              loading={busy}
              disabled={!edit.text.trim()}
            >
              {t("questionnaire.saveComment")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setEdit(null);
                setFailure(null);
              }}
            >
              {t("common.cancel")}
            </Button>
          </Space>
        </form>
      ) : (
        <>
          <p className="questionnaire-text">{comment.text}</p>
          {props.view.capabilities.comment &&
            comment.personId === props.view.personId && (
              <Button
                onClick={() => {
                  setEdit({ text: comment.text, revision: comment.revision });
                  setFailure(null);
                }}
              >
                {t("questionnaire.editComment")}
              </Button>
            )}
        </>
      )}
      {comment.revisions.length > 1 && (
        <details className="questionnaire-history">
          <summary>{t("questionnaire.editHistory")}</summary>
          {comment.revisions.map((revision) => (
            <div key={revision.revision}>
              <p className="muted">
                {format("questionnaire.commentRevision", {
                  number: revision.revision,
                })}{" "}
                · {new Date(revision.createdAt).toLocaleString(locale)}
              </p>
              <p className="questionnaire-text">{revision.text}</p>
            </div>
          ))}
        </details>
      )}
    </article>
  );
}

/** Editors keep their local text and reviewed revision across live refreshes. */
export function QuestionThread(props: ThreadProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const comments = props.view.comments.filter(
    (c) => c.questionId === props.questionId,
  );
  const post = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setFailure(null);
    try {
      await questionnaireRequest(
        props.basePath,
        `${props.path}/questions/${encodeURIComponent(props.questionId)}/comments`,
        "POST",
        { text },
      );
      setText("");
      props.onChanged();
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : t("questionnaire.failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      data-testid="question-thread"
      aria-labelledby="thread-comments-title"
    >
      <h3 id="thread-comments-title">{t("questionnaire.comments")}</h3>
      {comments.length === 0 && (
        <p className="muted">{t("questionnaire.noComments")}</p>
      )}
      {comments.map((comment) => (
        <Comment {...props} key={comment.id} comment={comment} />
      ))}
      {props.view.capabilities.comment && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void post();
          }}
        >
          {failure && <Alert type="error" showIcon message={failure} />}
          <label className="field-label" htmlFor="new-comment">
            {t("questionnaire.commentText")}
          </label>
          <Input.TextArea
            id="new-comment"
            value={text}
            maxLength={20000}
            autoSize={{ minRows: 3, maxRows: 12 }}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
          <Button
            className="questionnaire-actions"
            htmlType="submit"
            loading={busy}
            disabled={!text.trim()}
          >
            {t("questionnaire.postComment")}
          </Button>
        </form>
      )}
    </section>
  );
}
