import { useBusinessVersion } from "../data/invalidation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ExportResult,
  Member,
  ReportDraft,
  ReportFileKey,
  ReportFilePreview,
  ReportPreview,
  ScoreEntry,
  Settings,
} from "../../shared/contracts";
import { scoreTotal, suggestedAttendanceScore } from "../../domain/report";
import { hoursLabel, formatLocalDate } from "../../domain/time";
import { Hours, EmptyState } from "../components";
import { errorMessage } from "../App";
import { registerNavigationGuard } from "../data/navigation";
import { DraftSession, reportDraftStore } from "../data/draft-store";
import {
  AppButton,
  AppDialog,
  AppInput,
  AppSelect,
  AppTextarea,
  useFeedback,
} from "../ui";

const FILE_LABELS: Record<ReportFileKey, string> = {
  workReport: "部门工作报表",
  performance: "全员绩效考核表",
  timeRecord: "团队工时记录表",
  schedule: "正式排班表",
  wageAssessment: "工资考核表",
};
export function ReportsPage({ members }: { members: Member[] }) {
  const [period, setPeriod] = useState(formatLocalDate(new Date()).slice(0, 7));
  const [session, setSession] = useState<DraftSession | null>(null);
  const [error, setError] = useState("");
  const [changing, setChanging] = useState(false);
  const [retry, setRetry] = useState(0);
  const { confirm } = useFeedback();
  useEffect(() => {
    let active = true;
    const [y, m] = period.split("-").map(Number);
    void reportDraftStore()
      .open(y!, m!)
      .then((s) => {
        if (active) {
          setSession(s);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [period, retry]);
  async function changePeriod(next: string) {
    if (!/^\d{4}-\d{2}$/.test(next) || next === period || changing) return;
    setChanging(true);
    try {
      await session?.flush();
      setSession(null);
      setPeriod(next);
    } catch (e) {
      setError(errorMessage(e));
      if (
        await confirm({
          title: "本月草稿保存失败",
          message:
            "输入仍保留。可以取消切月并重试，或明确放弃未保存修改后切月。",
          confirmLabel: "放弃并切月",
          cancelLabel: "取消切月",
        })
      ) {
        session?.discard();
        setSession(null);
        setPeriod(next);
      }
    } finally {
      setChanging(false);
    }
  }
  return (
    <div className="page-stack report-page">
      <div className="page-header">
        <div>
          <h1>月度导出</h1>
          <p>编辑内容自动保存；本次导出使用同一份固定数据快照。</p>
        </div>
        <label>
          所属月份
          <AppInput
            type="month"
            aria-label="所属月份"
            value={period}
            disabled={changing}
            onChange={(e) => {
              void changePeriod(e.target.value);
            }}
          />
        </label>
      </div>
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      {session ? (
        <ReportWorkspace key={period} session={session} members={members} />
      ) : error ? (
        <AppButton
          onClick={() => {
            setError("");
            setRetry((v) => v + 1);
          }}
        >
          重试读取草稿
        </AppButton>
      ) : (
        <p role="status">正在读取草稿…</p>
      )}
    </div>
  );
}
function ReportWorkspace({
  session,
  members,
}: {
  session: DraftSession;
  members: Member[];
}) {
  const businessVersion = useBusinessVersion();
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const draft = state.draft!;
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [previewVersion, setPreviewVersion] = useState(-1);
  const [activeFile, setActiveFile] = useState<ReportFileKey>("workReport");
  const [showPreview, setShowPreview] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [settings, setSettings] = useState<Settings>({
    attendanceMode: "lenient",
    lateThresholdMinutes: 15,
    latePenaltyPoints: 1,
  });
  useEffect(() => registerNavigationGuard(async () => !exportLock.current), []);
  const token = useRef(0);
  const exportId = useRef<string | null>(null);
  const exportLock = useRef(false);
  useEffect(() => {
    void window.checkinApi
      .getSettings()
      .then(setSettings)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    const version = state.version;
    const request = ++token.current;
    let active = true;
    const timer = setTimeout(() => {
      void window.checkinApi
        .previewReports(draft)
        .then(async (value) => {
          const dataRevision = await window.checkinApi.getDataRevision();
          if (
            active &&
            request === token.current &&
            session.snapshot().version === version &&
            value.dataRevision === dataRevision
          ) {
            setPreview(value);
            setPreviewVersion(version);
            setError("");
          }
        })
        .catch((e) => {
          if (active && request === token.current) setError(errorMessage(e));
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [draft, state.version, session, businessVersion]);
  function setDraft(next: ReportDraft) {
    if (exportLock.current) return;
    exportId.current = null;
    session.edit(next);
  }
  async function exportFiles() {
    if (exportLock.current) return;
    exportLock.current = true;
    setExporting(true);
    setError("");
    try {
      await session.flush();
      const saved = session.snapshot().draft!;
      const fixed = await window.checkinApi.previewReports(saved);
      exportId.current ??= crypto.randomUUID();
      const generated = await window.checkinApi.exportReports(
        saved,
        fixed.dataRevision,
        exportId.current,
      );
      setResult(generated);
      exportId.current = null;
      setPreview(fixed);
      setPreviewVersion(session.snapshot().version);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      exportLock.current = false;
      setExporting(false);
    }
  }
  const activePreview =
    preview?.files.find((f) => f.key === activeFile) ?? null;
  return (
    <>
      <div className="report-save-line">
        <span role="status" className={`save-state ${state.status}`}>
          {
            {
              loading: "正在读取",
              saving: "保存中…",
              unsaved: "尚未保存",
              saved: "已保存",
              error: "保存失败",
            }[state.status]
          }
        </span>
        {state.status === "error" && (
          <AppButton
            size="compact"
            onClick={() =>
              session.flush().catch((e) => setError(errorMessage(e)))
            }
          >
            重试保存
          </AppButton>
        )}
        <span>草稿版本 {draft.revision ?? 0}</span>
      </div>
      {(error || state.error) && (
        <div className="inline-error" role="alert">
          {error || state.error}
        </div>
      )}
      <section className="report-parameters">
        <div className="form-grid four">
          <label>
            填写日期
            <AppInput
              type="date"
              aria-label="填写日期"
              value={draft.fillDate}
              onChange={(e) => setDraft({ ...draft, fillDate: e.target.value })}
            />
          </label>
          <label>
            填表人/统计者
            <AppInput
              aria-label="填表人"
              value={draft.filler}
              onChange={(e) => setDraft({ ...draft, filler: e.target.value })}
            />
          </label>
          <label>
            统计开始
            <AppInput
              type="date"
              aria-label="统计开始"
              value={draft.startDate}
              onChange={(e) =>
                setDraft({ ...draft, startDate: e.target.value })
              }
            />
          </label>
          <label>
            统计结束
            <AppInput
              type="date"
              aria-label="统计结束"
              value={draft.endDate}
              onChange={(e) => setDraft({ ...draft, endDate: e.target.value })}
            />
          </label>
          <label>
            部门名称
            <AppInput
              aria-label="部门名称"
              value={draft.department}
              onChange={(e) =>
                setDraft({ ...draft, department: e.target.value })
              }
            />
          </label>
          <label className="output-directory">
            输出目录
            <div className="input-button">
              <AppInput
                aria-label="输出目录"
                value={draft.outputDirectory}
                readOnly
                placeholder="尚未选择"
              />
              <AppButton
                disabled={exporting}
                onClick={async () => {
                  try {
                    const directory =
                      await window.checkinApi.chooseOutputDirectory();
                    if (directory)
                      setDraft({
                        ...session.snapshot().draft!,
                        outputDirectory: directory,
                      });
                  } catch (e) {
                    setError(errorMessage(e));
                  }
                }}
              >
                选择
              </AppButton>
            </div>
          </label>
        </div>
      </section>
      <div className="report-workspace">
        <aside className="file-sidebar">
          <h2>文件目录</h2>
          <p>勾选用于导出，点击名称查看。</p>
          {(Object.keys(FILE_LABELS) as ReportFileKey[]).map((key) => (
            <div
              className={`file-item ${activeFile === key ? "active" : ""}`}
              key={key}
            >
              <AppInput
                type="checkbox"
                aria-label={`导出 ${FILE_LABELS[key]}`}
                checked={draft.selectedFiles.includes(key)}
                disabled={exporting}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    selectedFiles: e.target.checked
                      ? [...draft.selectedFiles, key]
                      : draft.selectedFiles.filter((k) => k !== key),
                  })
                }
              />
              <AppButton
                variant="quiet"
                aria-current={activeFile === key ? "true" : undefined}
                onClick={() => {
                  setActiveFile(key);
                  setShowPreview(false);
                }}
              >
                <strong>{FILE_LABELS[key]}</strong>
                <small>{key === "timeRecord" ? "XLSX" : "DOCX"}</small>
              </AppButton>
            </div>
          ))}
          <AppButton
            variant="primary"
            className="wide"
            pending={exporting}
            disabled={
              !draft.outputDirectory ||
              !draft.selectedFiles.length ||
              state.status === "loading"
            }
            onClick={exportFiles}
          >
            导出所选 {draft.selectedFiles.length} 个文件
          </AppButton>
        </aside>
        <section className="report-content">
          <div className="workspace-tabs">
            <AppButton
              variant="quiet"
              className={!showPreview ? "active" : ""}
              onClick={() => setShowPreview(false)}
            >
              编辑内容
            </AppButton>
            <AppButton
              variant="quiet"
              className={showPreview ? "active" : ""}
              onClick={() => setShowPreview(true)}
            >
              内容预览
            </AppButton>
            <span>{previewVersion !== state.version ? "预览更新中…" : ""}</span>
          </div>
          {showPreview ? (
            <div className="report-preview">
              <ContentPreview file={activePreview} />
            </div>
          ) : (
            <div className="report-editor">
              <ReportEditor
                fileKey={activeFile}
                draft={draft}
                setDraft={setDraft}
                members={members}
                preview={preview}
                settings={settings}
              />
            </div>
          )}
        </section>
      </div>
      <AppDialog
        open={Boolean(result)}
        title="导出完成"
        onClose={() => setResult(null)}
      >
        {result && (
          <>
            <p>
              已生成 {result.files.length} 个文件，保存到 {result.directory}。
            </p>
            <ul>
              {result.files.map((f) => (
                <li key={f.key}>{f.fileName}</li>
              ))}
            </ul>
            {result.warnings.map((w) => (
              <p className="warning-banner" key={w}>
                {w}
              </p>
            ))}
            <AppButton
              variant="primary"
              onClick={() => window.checkinApi.openPath(result.directory)}
            >
              打开导出文件夹
            </AppButton>
          </>
        )}
      </AppDialog>
    </>
  );
}
function ReportEditor({
  fileKey,
  draft,
  setDraft,
  members,
  preview,
  settings,
}: {
  fileKey: ReportFileKey;
  draft: ReportDraft;
  setDraft(value: ReportDraft): void;
  members: Member[];
  preview: ReportPreview | null;
  settings: Settings;
}) {
  if (fileKey === "workReport")
    return (
      <div>
        <h2>部门工作报表</h2>
        <p className="editor-help">每组保留三条，支持多行文字。</p>
        <TripleFields
          title="完成的工作"
          values={draft.workItems}
          onChange={(values) => setDraft({ ...draft, workItems: values })}
        />
        <PairedFields draft={draft} setDraft={setDraft} />
        <TripleFields
          title="下月安排"
          values={draft.plans}
          onChange={(values) => setDraft({ ...draft, plans: values })}
        />
        <label>
          意见建议
          <AppTextarea
            rows={4}
            value={draft.advice}
            onChange={(event) =>
              setDraft({ ...draft, advice: event.target.value })
            }
          />
        </label>
      </div>
    );
  if (fileKey === "performance")
    return (
      <PerformanceEditor
        draft={draft}
        setDraft={setDraft}
        preview={preview}
        settings={settings}
        members={members}
      />
    );
  if (fileKey === "wageAssessment")
    return (
      <WageEditor
        draft={draft}
        setDraft={setDraft}
        preview={preview}
        members={members}
      />
    );
  if (fileKey === "timeRecord")
    return (
      <ReadOnlySource
        title="团队工时记录表"
        description="系统计算结果写入 Excel，工时单位为 h。"
      />
    );
  return (
    <ReadOnlySource
      title="正式排班表"
      description="原始排班 Excel 表格将写入 DOCX。"
    />
  );
}

function TripleFields({
  title,
  values,
  onChange,
}: {
  title: string;
  values: [string, string, string];
  onChange(values: [string, string, string]): void;
}) {
  return (
    <fieldset>
      <legend>{title}</legend>
      {values.map((value, index) => (
        <AppTextarea
          key={index}
          rows={3}
          aria-label={`${title} ${index + 1}`}
          value={value}
          onChange={(event) => {
            const next = [...values] as [string, string, string];
            next[index] = event.target.value;
            onChange(next);
          }}
        />
      ))}
    </fieldset>
  );
}

function PairedFields({
  draft,
  setDraft,
}: {
  draft: ReportDraft;
  setDraft(value: ReportDraft): void;
}) {
  return (
    <fieldset>
      <legend>问题与反思对策</legend>
      {draft.questions.map((question, index) => (
        <div className="paired-field" key={index}>
          <AppTextarea
            rows={3}
            placeholder={`问题 ${index + 1}`}
            value={question}
            onChange={(event) => {
              const next = [...draft.questions] as [string, string, string];
              next[index] = event.target.value;
              setDraft({ ...draft, questions: next });
            }}
          />
          <AppTextarea
            rows={3}
            placeholder={`反思和对策 ${index + 1}`}
            value={draft.reflections[index]}
            onChange={(event) => {
              const next = [...draft.reflections] as [string, string, string];
              next[index] = event.target.value;
              setDraft({ ...draft, reflections: next });
            }}
          />
        </div>
      ))}
    </fieldset>
  );
}

const SCORE_FIELDS: Array<{
  key: keyof Pick<
    ScoreEntry,
    "attendance" | "hours" | "self" | "peer" | "supervisor" | "activity"
  >;
  label: string;
  max: number;
}> = [
  { key: "attendance", label: "考勤", max: 30 },
  { key: "hours", label: "工时", max: 10 },
  { key: "self", label: "自评", max: 10 },
  { key: "peer", label: "互评", max: 20 },
  { key: "supervisor", label: "负责人", max: 30 },
  { key: "activity", label: "活动", max: 5 },
];

function PerformanceEditor({
  draft,
  setDraft,
  preview,
  settings,
  members,
}: {
  draft: ReportDraft;
  setDraft(value: ReportDraft): void;
  preview: ReportPreview | null;
  settings: Settings;
  members: Member[];
}) {
  const summaries = preview?.snapshot.members ?? [];
  const defaults = (memberId: string): ScoreEntry => {
    const summary = summaries.find((item) => item.memberId === memberId);
    return {
      attendance: suggestedAttendanceScore(
        summary?.lateCount ?? 0,
        settings.latePenaltyPoints,
      ),
      hours: 10,
      self: 10,
      peer: 20,
      supervisor: 30,
      activity: 0,
    };
  };
  const score = (memberId: string) =>
    draft.scores[memberId] ?? defaults(memberId);
  return (
    <div className="performance-editor">
      <h2>工时与评分</h2>
      <p className="editor-help">
        考勤生成建议值，手工修改后保留；活动附加默认 0。
      </p>
      <div className="table-scroll">
        <table className="score-table">
          <thead>
            <tr>
              <th>成员</th>
              {SCORE_FIELDS.map((field) => (
                <th key={field.key}>
                  {field.label}
                  <small>/{field.max}</small>
                </th>
              ))}
              <th>总分</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((summary) => {
              const current = score(summary.memberId);
              return (
                <tr key={summary.memberId}>
                  <td>
                    <strong>{summary.memberName}</strong>
                    <small>
                      <Hours minutes={summary.totalMinutes} /> · 迟到{" "}
                      {summary.lateCount}
                    </small>
                  </td>
                  {SCORE_FIELDS.map((field) => (
                    <td key={field.key}>
                      <AppInput
                        type="number"
                        aria-label={summary.memberName + " " + field.label}
                        min="0"
                        max={field.max}
                        value={current[field.key] ?? ""}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            scores: {
                              ...draft.scores,
                              [summary.memberId]: {
                                ...current,
                                [field.key]:
                                  event.target.value === ""
                                    ? null
                                    : Number(event.target.value),
                                ...(field.key === "attendance"
                                  ? { attendanceOverridden: true }
                                  : {}),
                              },
                            },
                          })
                        }
                      />
                    </td>
                  ))}
                  <td>
                    <strong>{scoreTotal(current) ?? "—"}</strong>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <fieldset>
        <legend>月度优秀员工推荐 可不填</legend>
        {draft.recommendations.map((recommendation, index) => (
          <div className="recommendation-row" key={index}>
            <AppSelect
              aria-label={"优秀员工推荐 " + (index + 1)}
              value={recommendation.memberId ?? ""}
              onChange={(event) => {
                const next = [
                  ...draft.recommendations,
                ] as ReportDraft["recommendations"];
                next[index] = {
                  ...recommendation,
                  memberId: event.target.value || null,
                };
                setDraft({ ...draft, recommendations: next });
              }}
            >
              <option value="">不推荐</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </AppSelect>
            <AppTextarea
              rows={2}
              placeholder="推荐原因"
              value={recommendation.reason}
              onChange={(event) => {
                const next = [
                  ...draft.recommendations,
                ] as ReportDraft["recommendations"];
                next[index] = { ...recommendation, reason: event.target.value };
                setDraft({ ...draft, recommendations: next });
              }}
            />
          </div>
        ))}
      </fieldset>
    </div>
  );
}

function WageEditor({
  draft,
  setDraft,
  preview,
  members,
}: {
  draft: ReportDraft;
  setDraft(value: ReportDraft): void;
  preview: ReportPreview | null;
  members: Member[];
}) {
  const summaries = preview?.snapshot.members ?? [];
  return (
    <div className="wage-editor">
      <h2>工资考核表</h2>
      <div className="table-scroll">
        <table className="wage-editor-table">
          <thead>
            <tr>
              <th>成员</th>
              <th>系统工时</th>
              <th>工作量</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const summary = summaries.find(
                (item) => item.memberId === member.id,
              );
              const systemWorkload = `${hoursLabel(summary?.totalMinutes ?? 0)}h`;
              return (
                <tr key={member.id}>
                  <td>
                    <strong>{member.name}</strong>
                  </td>
                  <td>{systemWorkload}</td>
                  <td>
                    <AppInput
                      aria-label={`${member.name}工作量`}
                      value={draft.wageWorkloads[member.id] ?? systemWorkload}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          wageWorkloads: {
                            ...draft.wageWorkloads,
                            [member.id]: event.target.value,
                          },
                        })
                      }
                    />
                  </td>
                  <td>
                    <AppInput
                      aria-label={`${member.name}备注`}
                      value={draft.wageNotes[member.id] ?? ""}
                      placeholder="可留空"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          wageNotes: {
                            ...draft.wageNotes,
                            [member.id]: event.target.value,
                          },
                        })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReadOnlySource({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return <EmptyState title={title} description={description} />;
}

function ContentPreview({ file }: { file: ReportFilePreview | null }) {
  const tables = useMemo(() => file?.tables ?? [], [file]);
  if (!file) return <div className="page-loading compact">正在生成…</div>;
  return (
    <div className="preview-document">
      <h3>{file.title}</h3>
      {file.paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      {file.warnings.map((warning) => (
        <div className="preview-warning" key={warning}>
          {warning}
        </div>
      ))}
      {tables.map((table) => (
        <div className="preview-table" key={table.title}>
          <h4>{table.title}</h4>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {table.headers.map((header) => (
                    <th key={header}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.slice(0, 100).map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {table.rows.length > 100 && (
            <p>预览显示前 100 行；导出包含全部 {table.rows.length} 行。</p>
          )}
        </div>
      ))}
    </div>
  );
}
