import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type ChangeEvent,
} from "react";
import {
  Button,
  Input,
  TextArea,
  Select,
  SelectValue,
  Popover,
  ListBox,
  ListBoxItem,
  ComboBox,
  Checkbox,
  Switch,
  NumberField,
  Group,
  DatePicker,
  DateInput,
  DateSegment,
  Calendar,
  CalendarGrid,
  CalendarCell,
  Heading,
  TimeField,
  ModalOverlay,
  Modal,
  Dialog,
  MenuTrigger,
  Menu,
  MenuItem,
  I18nProvider,
} from "react-aria-components";
import { parseDate, parseDateTime, parseTime } from "@internationalized/date";
import type { Member } from "../../shared/contracts";

const change = <T extends HTMLInputElement | HTMLSelectElement>(
  value: string,
  checked?: boolean,
) =>
  ({
    target: { value, checked },
    currentTarget: { value, checked },
  }) as unknown as ChangeEvent<T>;
export function AppButton({
  variant,
  size = "normal",
  pending = false,
  className = "",
  disabled,
  onClick,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: "normal" | "compact";
  pending?: boolean;
}) {
  const [running, setRunning] = useState(false);
  const lock = useRef(false);
  const { notify } = useFeedback();
  const kind =
    variant ??
    (className.includes("primary")
      ? "primary"
      : className.includes("danger")
        ? "danger"
        : className.includes("text")
          ? "quiet"
          : "secondary");
  return (
    <Button
      {...(props as import("react-aria-components").ButtonProps)}
      className={`ui-button ${kind} ${size} ${className}`}
      isDisabled={disabled || pending || running}
      isPending={pending || running}
      onPress={async () => {
        if (lock.current) return;
        lock.current = true;
        setRunning(true);
        try {
          await onClick?.({} as React.MouseEvent<HTMLButtonElement>);
        } catch (e) {
          notify(e instanceof Error ? e.message : String(e));
        } finally {
          lock.current = false;
          setRunning(false);
        }
      }}
    >
      {children}
    </Button>
  );
}

type Option = {
  id: string;
  label: string;
  disabled?: boolean;
  description?: string;
};
const labelText = (node: ReactNode): string =>
  Children.toArray(node)
    .map((n) =>
      typeof n === "string" || typeof n === "number"
        ? String(n)
        : isValidElement<{ children?: ReactNode }>(n)
          ? labelText(n.props.children)
          : "",
    )
    .join("");
function optionsOf(nodes: ReactNode): Option[] {
  const options: Option[] = [];
  Children.forEach(nodes, (child) => {
    if (
      !isValidElement<{
        value?: string | number;
        children?: ReactNode;
        disabled?: boolean;
      }>(child)
    )
      return;
    if (child.type === "option")
      options.push({
        id: String(child.props.value ?? labelText(child.props.children)),
        label: labelText(child.props.children),
        disabled: child.props.disabled,
      });
    else options.push(...optionsOf(child.props.children));
  });
  return options;
}
export function AppSelect({
  children,
  value,
  onChange,
  disabled,
  className = "",
  searchable,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { searchable?: boolean }) {
  const options = optionsOf(children);
  const selected = String(value ?? "");
  const search =
    searchable ?? options.some((o) => /^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(o.id));
  const name = props["aria-label"] ?? props.name ?? "选择";
  const invalid =
    props["aria-invalid"] === true || props["aria-invalid"] === "true";
  if (search)
    return (
      <SearchSelect
        options={options}
        value={selected}
        onChange={(v) => onChange?.(change<HTMLSelectElement>(v))}
        disabled={disabled}
        label={name}
        className={className}
        invalid={invalid}
      />
    );
  return (
    <Select
      aria-label={name}
      id={props.id}
      className={`ui-select ${className}`}
      selectedKey={selected || "__empty"}
      onSelectionChange={(key) =>
        onChange?.(
          change<HTMLSelectElement>(key === "__empty" ? "" : String(key)),
        )
      }
      isDisabled={disabled}
      isInvalid={invalid}
    >
      <Button className="ui-select-trigger">
        <SelectValue />
        <span aria-hidden="true">⌄</span>
      </Button>
      <Popover className="ui-popover" placement="bottom start">
        <ListBox
          className="ui-listbox"
          items={options.map((o) => ({ ...o, key: o.id || "__empty" }))}
        >
          {(item) => (
            <ListBoxItem
              id={item.key}
              textValue={item.label}
              isDisabled={item.disabled}
              className="ui-option"
            >
              {({ isSelected }) => (
                <>
                  <span>{item.label}</span>
                  <span aria-hidden="true">{isSelected ? "✓" : ""}</span>
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}
function SearchSelect({
  options,
  value,
  onChange,
  disabled,
  label,
  className = "",
  invalid = false,
}: {
  options: Option[];
  value: string;
  onChange(v: string): void;
  disabled?: boolean;
  label: string;
  className?: string;
  invalid?: boolean;
}) {
  const [query, setQuery] = useState(
    options.find((o) => o.id === value)?.label ?? "",
  );
  const composing = useRef(false);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current || value)
      setQuery(options.find((o) => o.id === value)?.label ?? "");
    editing.current = false;
  }, [value, options.map((o) => o.id + o.label).join("|")]);
  const stableOptions = useMemo(() => options, [JSON.stringify(options)]);
  const matches = useMemo(
    () =>
      stableOptions.filter(
        (o) =>
          !query ||
          query === stableOptions.find((o) => o.id === value)?.label ||
          `${o.label} ${o.description ?? ""}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
      ),
    [stableOptions, query, value],
  );
  return (
    <ComboBox
      aria-label={label}
      className={`ui-combobox ${className}`}
      items={matches}
      selectedKey={value || null}
      inputValue={query}
      isDisabled={disabled}
      isInvalid={invalid}
      allowsCustomValue
      allowsEmptyCollection
      menuTrigger="focus"
      onInputChange={setQuery}
      onSelectionChange={(key) => {
        if (key !== null) {
          const item = options.find((o) => (o.id || "__empty") === String(key));
          if (item && !item.disabled) {
            onChange(item.id);
            setQuery(item.label);
          }
        }
      }}
    >
      <Group className="ui-select-trigger">
        <Input
          placeholder="搜索并选择人员"
          onChange={(event) => {
            editing.current = true;
            if (
              event.target.value !== options.find((o) => o.id === value)?.label
            )
              onChange("");
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDownCapture={(e) => {
            if (
              e.key === "Enter" &&
              (composing.current || e.nativeEvent.isComposing)
            )
              e.stopPropagation();
          }}
        />
        <Button aria-label="显示选项">⌄</Button>
      </Group>
      <Popover className="ui-popover" placement="bottom start">
        <ListBox<Option>
          className="ui-listbox"
          renderEmptyState={() => "没有匹配结果，请换一个关键词"}
        >
          {(item) => (
            <ListBoxItem
              id={item.id || "__empty"}
              textValue={item.label}
              isDisabled={item.disabled}
              className="ui-option"
            >
              {({ isSelected }) => (
                <>
                  <span>
                    {item.label}
                    {item.description && <small>{item.description}</small>}
                  </span>
                  <span aria-hidden="true">{isSelected ? "✓" : ""}</span>
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
export function MemberCombobox({
  members,
  value,
  onChange,
  label = "人员",
  disabled,
  excluded = [],
}: {
  members: Member[];
  value: string;
  onChange(v: string): void;
  label?: string;
  disabled?: boolean;
  excluded?: string[];
}) {
  return (
    <SearchSelect
      label={label}
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={members.map((m) => ({
        id: m.id,
        label: m.name,
        description: [
          m.college,
          m.studentId ? `学号尾号 ${m.studentId.slice(-4)}` : "",
          excluded.includes(m.id) ? "已在本班，不可重复加入" : "",
        ]
          .filter(Boolean)
          .join(" · "),
        disabled: excluded.includes(m.id),
      }))}
    />
  );
}

export function AppInput({
  type = "text",
  onChange,
  value,
  checked,
  disabled,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  const label =
    props["aria-label"] ??
    props.name ??
    (type === "date"
      ? "日期"
      : type === "time"
        ? "时间"
        : type === "number"
          ? "数值"
          : "选择");
  if (type === "checkbox") {
    const Control = props.role === "switch" ? Switch : Checkbox;
    return (
      <Control
        aria-label={label}
        className={`ui-checkbox ${props.role === "switch" ? "ui-switch" : ""} ${className}`}
        isSelected={checked}
        isDisabled={disabled}
        onChange={(next) => onChange?.(change<HTMLInputElement>("", next))}
      >
        <span className="ui-check-mark" aria-hidden="true">
          {checked ? "✓" : ""}
        </span>
      </Control>
    );
  }
  if (type === "number")
    return (
      <NumberField
        aria-label={label}
        className={`ui-number ${className}`}
        value={value === "" || value == null ? NaN : Number(value)}
        minValue={props.min === undefined ? undefined : Number(props.min)}
        maxValue={props.max === undefined ? undefined : Number(props.max)}
        step={props.step === undefined ? 1 : Number(props.step)}
        isDisabled={disabled}
        isReadOnly={props.readOnly}
        onChange={(n) =>
          onChange?.(change<HTMLInputElement>(Number.isNaN(n) ? "" : String(n)))
        }
      >
        <Input className="ui-input" />
      </NumberField>
    );
  if (type === "time") {
    let time;
    try {
      time = value ? parseTime(String(value)) : null;
    } catch {
      time = null;
    }
    return (
      <TimeField
        aria-label={label}
        className="ui-date"
        value={time}
        hourCycle={24}
        granularity="minute"
        isDisabled={disabled}
        onChange={(v) =>
          onChange?.(
            change<HTMLInputElement>(v ? v.toString().slice(0, 5) : ""),
          )
        }
      >
        <DateInput>{(segment) => <DateSegment segment={segment} />}</DateInput>
      </TimeField>
    );
  }
  if (type === "date" || type === "datetime-local") {
    let date;
    try {
      date = value
        ? type === "date"
          ? parseDate(String(value))
          : parseDateTime(String(value))
        : null;
    } catch {
      date = null;
    }
    return (
      <DatePicker
        aria-label={label}
        className={`ui-date ${className}`}
        value={date}
        granularity={type === "date" ? "day" : "minute"}
        hourCycle={24}
        isDisabled={disabled}
        isReadOnly={props.readOnly}
        onChange={(v) =>
          onChange?.(change<HTMLInputElement>(v?.toString() ?? ""))
        }
      >
        <Group>
          <DateInput>
            {(segment) => <DateSegment segment={segment} />}
          </DateInput>
          <Button aria-label="打开日期选择">▦</Button>
        </Group>
        <Popover className="ui-popover">
          <Dialog>
            <Calendar>
              <header className="ui-calendar-header">
                <Button slot="previous" aria-label="上个月">
                  ‹
                </Button>
                <Heading />
                <Button slot="next" aria-label="下个月">
                  ›
                </Button>
              </header>
              <CalendarGrid>
                {(date) => <CalendarCell date={date} />}
              </CalendarGrid>
            </Calendar>
          </Dialog>
        </Popover>
      </DatePicker>
    );
  }
  return (
    <Input
      {...props}
      type={type}
      value={value}
      disabled={disabled}
      onChange={onChange}
      className={`ui-input ${className}`}
    />
  );
}
export function AppTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  return (
    <TextArea
      {...props}
      className={`ui-input ui-textarea ${props.className ?? ""}`}
    />
  );
}
export function AppDialog({
  open,
  title,
  onClose,
  children,
  drawer = false,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  drawer?: boolean;
}) {
  return (
    <ModalOverlay
      className={`ui-overlay ${drawer ? "drawer" : ""}`}
      isOpen={open}
      isDismissable
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Modal className="ui-modal">
        <Dialog aria-label={title}>
          <header className="ui-dialog-header">
            <Heading slot="title">{title}</Heading>
            <AppButton variant="quiet" aria-label="关闭" onClick={onClose}>
              ×
            </AppButton>
          </header>
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
export function ActionMenu({
  label = "更多操作",
  items,
}: {
  label?: string;
  items: Array<{
    id: string;
    label: string;
    disabled?: boolean;
    danger?: boolean;
    action(): void;
  }>;
}) {
  return (
    <MenuTrigger>
      <Button className="ui-button quiet compact" aria-label={label}>
        •••
      </Button>
      <Popover className="ui-popover">
        <Menu
          aria-label={label}
          className="ui-listbox"
          onAction={(id) => items.find((i) => i.id === id)?.action()}
        >
          {items.map((item) => (
            <MenuItem
              key={item.id}
              id={item.id}
              isDisabled={item.disabled}
              className={`ui-option ${item.danger ? "danger-text" : ""}`}
            >
              {item.label}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
type Notice = {
  id: number;
  text: string;
  actionLabel?: string;
  action?: () => Promise<void>;
};
type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
};
const Feedback = createContext<{
  notify(
    text: string,
    action?: () => Promise<void>,
    actionLabel?: string,
  ): void;
  confirm(input: ConfirmRequest): Promise<boolean>;
}>({ notify() {}, confirm: async () => false });
export const useFeedback = () => useContext(Feedback);
export function UiProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const timerState = useRef({ id: 0, remaining: 10_000 });
  const [confirmation, setConfirmation] = useState<
    (ConfirmRequest & { resolve(v: boolean): void }) | null
  >(null);
  useEffect(() => {
    if (!notice) return;
    if (timerState.current.id !== notice.id)
      timerState.current = { id: notice.id, remaining: 10_000 };
    if (hovered || focused) return;
    const state = timerState.current;
    const start = performance.now();
    const t = setTimeout(() => setNotice(null), state.remaining);
    return () => {
      clearTimeout(t);
      state.remaining = Math.max(
        0,
        state.remaining - (performance.now() - start),
      );
    };
  }, [notice, hovered, focused]);
  const notify = useCallback(
    (text: string, action?: () => Promise<void>, actionLabel = "撤销") => {
      setHovered(false);
      setFocused(false);
      setNotice({ id: Date.now(), text, action, actionLabel });
    },
    [],
  );
  const confirm = useCallback(
    (input: ConfirmRequest) =>
      new Promise<boolean>((resolve) =>
        setConfirmation((previous) => {
          previous?.resolve(false);
          return { ...input, resolve };
        }),
      ),
    [],
  );
  return (
    <I18nProvider locale="zh-CN">
      <Feedback.Provider value={{ notify, confirm }}>
        {children}
        {notice && (
          <div
            className="ui-toast"
            role="status"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
            }}
          >
            <span>{notice.text}</span>
            {notice.action && (
              <AppButton
                variant="quiet"
                onClick={async () => {
                  try {
                    await notice.action!();
                    setNotice(null);
                  } catch (e) {
                    notify(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                {notice.actionLabel}
              </AppButton>
            )}
            <AppButton
              variant="quiet"
              aria-label="关闭提示"
              onClick={() => setNotice(null)}
            >
              ×
            </AppButton>
          </div>
        )}
        <AppDialog
          open={Boolean(confirmation)}
          title={confirmation?.title ?? "确认"}
          onClose={() => {
            confirmation?.resolve(false);
            setConfirmation(null);
          }}
        >
          <p>{confirmation?.message}</p>
          <div className="button-row">
            <AppButton
              variant="primary"
              onClick={() => {
                confirmation?.resolve(true);
                setConfirmation(null);
              }}
            >
              {confirmation?.confirmLabel ?? "确认"}
            </AppButton>
            <AppButton
              onClick={() => {
                confirmation?.resolve(false);
                setConfirmation(null);
              }}
            >
              {confirmation?.cancelLabel ?? "取消"}
            </AppButton>
          </div>
        </AppDialog>
      </Feedback.Provider>
    </I18nProvider>
  );
}
