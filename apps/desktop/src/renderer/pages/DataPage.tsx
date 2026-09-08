import { useCallback, useEffect, useState } from "react";
import type {
  BootstrapData,
  ImportPreview,
  Member,
} from "../../shared/contracts";
import { formatLocalDate } from "../../domain/time";
import { EmptyState } from "../components";
import { errorMessage } from "../App";
import { AppButton, AppDialog, AppInput, AppSelect, useFeedback } from "../ui";
import { useCommand } from "../data/commands";
import { registerNavigationGuard } from "../data/navigation";

export function DataPage({
  data,
  onChanged,
}: {
  data: BootstrapData;
  onChanged(): Promise<void>;
}) {
  const now = new Date();
  const [month, setMonth] = useState(formatLocalDate(now).slice(0, 7));
  const [effectiveDate, setEffectiveDate] = useState(formatLocalDate(now));
  const [editing, setEditing] = useState<{
    session: string;
    member: Member;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [resolutions, setResolutions] = useState<
    Record<string, "keep" | "replace">
  >({});
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const command = useCommand(onChanged);
  const { notify } = useFeedback();
  async function choose(kind: "schedule" | "members") {
    if (parsing || command.pending) return;
    setParsing(true);
    setError("");
    try {
      const next = await window.checkinApi.chooseImportPreview({
        kind,
        month,
        effectiveDate,
      });
      if (next) {
        setPreview(next);
        setResolutions({});
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setParsing(false);
    }
  }
  async function template(kind: "schedule" | "members") {
    try {
      const path = await window.checkinApi.saveImportTemplate(kind);
      if (path) notify("模板已保存");
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const filtered = data.members.filter((m) =>
    [m.name, m.college, m.studentId, m.role].some((s) => s.includes(query)),
  );
  return (
    <div className="page-stack">
      <div className="page-header">
        <div>
          <h1>成员与排班源</h1>
          <p>正式导入源独立保留，日历中的单次调整会在导入前逐项核对。</p>
        </div>
        <AppButton
          variant="quiet"
          onClick={() => window.checkinApi.openDataDirectory()}
        >
          打开数据目录
        </AppButton>
      </div>
      {(error || command.error) && (
        <div role="alert" className="inline-error">
          {error || command.error}
        </div>
      )}
      <div className="source-panels">
        <section>
          <h2>正式排班</h2>
          <p>选择 Excel，检查新增、差异与关联冲突后再应用。</p>
          <div className="form-grid two">
            <label>
              排班月份
              <AppInput
                type="month"
                aria-label="排班月份"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
              />
            </label>
            <label>
              生效日期
              <AppInput
                type="date"
                aria-label="生效日期"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
            </label>
          </div>
          <div className="button-row">
            <AppButton
              variant="primary"
              pending={parsing}
              disabled={command.pending || !month || !effectiveDate}
              onClick={() => choose("schedule")}
            >
              选择排班文件并预览
            </AppButton>
            <AppButton variant="quiet" onClick={() => template("schedule")}>
              下载排班模板
            </AppButton>
          </div>
        </section>
        <section>
          <h2>成员资料</h2>
          <p>学号和短号按文本保留。重名或重复行需要先在源文件中明确。</p>
          <div className="button-row">
            <AppButton
              disabled={parsing || command.pending}
              onClick={() => choose("members")}
            >
              选择成员信息表并预览
            </AppButton>
            <AppButton variant="quiet" onClick={() => template("members")}>
              下载人员模板
            </AppButton>
          </div>
        </section>
      </div>
      <section className="members-section">
        <div className="card-title-row">
          <h2>
            成员资料 <small>{data.members.length} 人</small>
          </h2>
          <div className="button-row">
            <AppInput
              type="search"
              aria-label="搜索成员"
              placeholder="姓名、学院或学号"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <AppButton
              onClick={() =>
                setEditing({
                  session: crypto.randomUUID(),
                  member: emptyMember(),
                })
              }
            >
              ＋ 新增成员
            </AppButton>
          </div>
        </div>
        {!filtered.length ? (
          <EmptyState
            title={query ? "没有匹配的成员" : "暂无成员"}
            description={
              query
                ? "换一个关键词，或清空筛选。"
                : "可以导入成员表，也可以手动新增。"
            }
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>学院</th>
                  <th>职务</th>
                  <th>学号</th>
                  <th>短号</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.name}</strong>
                    </td>
                    <td>{m.college || "—"}</td>
                    <td>{m.role || "—"}</td>
                    <td>{m.studentId || "—"}</td>
                    <td>{m.phone || "—"}</td>
                    <td>
                      <AppButton
                        size="compact"
                        variant="quiet"
                        aria-label={`编辑 ${m.name}`}
                        onClick={() =>
                          setEditing({
                            session: crypto.randomUUID(),
                            member: m,
                          })
                        }
                      >
                        编辑
                      </AppButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing && (
        <MemberEditor
          key={editing.session}
          member={editing.member}
          onCancel={() => setEditing(null)}
          onSave={async (member) => {
            const result = await command.run(
              () => window.checkinApi.saveMember(member),
              "成员资料已保存",
            );
            if (result) {
              setEditing(null);
              return true;
            }
            return false;
          }}
        />
      )}
      <AppDialog
        open={Boolean(preview)}
        title="导入预览"
        drawer
        onClose={() => {
          if (!command.pending) setPreview(null);
        }}
      >
        {preview && (
          <div className="page-stack">
            <p>
              <strong>{preview.fileName}</strong>
            </p>
            <div className="metric-grid">
              <div>
                <strong>{preview.additions.length}</strong>
                <span>新增</span>
              </div>
              <div>
                <strong>{preview.updates.length}</strong>
                <span>匹配更新</span>
              </div>
              <div>
                <strong>{preview.conflicts.length}</strong>
                <span>待处理关联</span>
              </div>
            </div>
            <p>预览期间文件或数据发生变化时，应用会停止并要求重新预览。</p>
            {preview.warnings.map((w) => (
              <p className="warning-banner" key={w}>
                {w}
              </p>
            ))}
            {preview.conflicts.length > 0 && (
              <section>
                <h3>逐项处理冲突</h3>
                {preview.conflicts.map((c) => (
                  <div className="import-conflict" key={c.id}>
                    <p>{c.description}</p>
                    <AppSelect
                      aria-label={`处理冲突 ${c.description}`}
                      value={resolutions[c.id] ?? ""}
                      onChange={(e) =>
                        setResolutions({
                          ...resolutions,
                          [c.id]: e.target.value as "keep" | "replace",
                        })
                      }
                    >
                      <option value="">请选择处理方式</option>
                      <option value="keep">保留原执行安排及关联</option>
                      {c.canReplace && (
                        <option value="replace">
                          应用正式源，替换本次调整
                        </option>
                      )}
                    </AppSelect>
                  </div>
                ))}
              </section>
            )}
            <details open>
              <summary>新增项目（{preview.additions.length}）</summary>
              <ul className="preview-diff">
                {preview.additions.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </details>
            <details>
              <summary>匹配更新（{preview.updates.length}）</summary>
              <ul className="preview-diff">
                {preview.updates.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </details>
            {command.error && (
              <div className="inline-error" role="alert">
                {command.error}
              </div>
            )}
            <div className="dialog-footer">
              <AppButton
                variant="primary"
                pending={command.pending}
                disabled={
                  preview.conflicts.some((c) => !resolutions[c.id]) ||
                  (preview.kind === "members" &&
                    (preview.conflicts.length > 0 ||
                      preview.warnings.length > 0))
                }
                onClick={async () => {
                  const result = await command.run(
                    () =>
                      window.checkinApi.applyImportPreview({
                        id: preview.id,
                        resolutions,
                      }),
                    "导入已应用",
                  );
                  if (result) {
                    notify(result.message);
                    setPreview(null);
                  }
                }}
              >
                确认应用导入
              </AppButton>
              <AppButton
                disabled={command.pending}
                onClick={() => setPreview(null)}
              >
                取消
              </AppButton>
            </div>
          </div>
        )}
      </AppDialog>
    </div>
  );
}
function emptyMember(): Member {
  return {
    id: "",
    name: "",
    college: "",
    role: "",
    phone: "",
    studentId: "",
    major: "",
    grade: "",
    employeeNo: "",
    active: true,
  };
}
function MemberEditor({
  member,
  onCancel,
  onSave,
}: {
  member: Member;
  onCancel(): void;
  onSave(value: Partial<Member> & { name: string }): Promise<boolean>;
}) {
  const [value, setValue] = useState(() => ({ ...member }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { confirm } = useFeedback();
  const dirty = JSON.stringify(value) !== JSON.stringify(member);
  const canClose = useCallback(
    async () =>
      !saving &&
      (!dirty ||
        (await confirm({
          title: "成员资料尚未保存",
          message:
            "当前修改属于 " +
            (member.name || "新成员") +
            "。放弃后不会写入其他成员。",
          confirmLabel: "放弃修改",
          cancelLabel: "继续编辑",
        }))),
    [dirty, saving, member.name, confirm],
  );
  useEffect(() => registerNavigationGuard(canClose), [canClose]);
  const fields: Array<[keyof Member, string]> = [
    ["name", "姓名"],
    ["college", "所属学院"],
    ["role", "职务"],
    ["phone", "电话/短号"],
    ["studentId", "学号"],
    ["major", "专业"],
    ["grade", "年级"],
    ["employeeNo", "工号"],
  ];
  return (
    <AppDialog
      open
      title={member.id ? `编辑 ${member.name}` : "新增成员"}
      drawer
      onClose={() => {
        void canClose().then((ok) => {
          if (ok) onCancel();
        });
      }}
    >
      <div className="form-grid two">
        {fields.map(([key, label]) => (
          <label key={key}>
            {label}
            {key === "name" ? " *" : ""}
            <AppInput
              aria-label={label}
              value={String(value[key])}
              disabled={saving}
              onChange={(e) => setValue({ ...value, [key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      <div className="dialog-footer">
        <AppButton
          variant="primary"
          disabled={!value.name.trim()}
          pending={saving}
          onClick={async () => {
            setSaving(true);
            try {
              if (!(await onSave({ ...value, id: member.id || undefined })))
                setError("保存失败，输入已保留，请重试。");
            } finally {
              setSaving(false);
            }
          }}
        >
          保存成员
        </AppButton>
        <AppButton
          disabled={saving}
          onClick={async () => {
            if (await canClose()) onCancel();
          }}
        >
          取消
        </AppButton>
      </div>
    </AppDialog>
  );
}
