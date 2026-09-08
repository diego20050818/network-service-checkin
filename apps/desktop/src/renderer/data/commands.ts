import { useEffect, useRef, useState } from "react";
import { useFeedback } from "../ui";
import { errorMessage } from "../App";
import type { OperationResult } from "../../shared/contracts";
import { registerNavigationGuard } from "./navigation";

/** A refresh failure must never be reported as a rejected write. */
export function useCommand(refresh: () => Promise<void>) {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { notify } = useFeedback();
  useEffect(
    () =>
      registerNavigationGuard(async () => {
        if (lock.current) {
          notify("正在保存操作，请稍候再离开。");
          return false;
        }
        return true;
      }),
    [notify],
  );
  async function run<T>(
    write: () => Promise<T>,
    label: string,
  ): Promise<T | undefined> {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError("");
    let result: T;
    try {
      result = await write();
    } catch (cause) {
      setError("写入失败：" + errorMessage(cause));
      lock.current = false;
      setPending(false);
      return;
    }
    const operation = (result as Partial<OperationResult> | null)?.operation;
    const undo = operation?.canUndo
      ? async () => {
          await window.checkinApi.undoOperation(operation.id);
          try {
            await refresh();
          } catch {
            notify("已撤销，但刷新失败。请重新加载页面。");
          }
        }
      : undefined;
    try {
      await refresh();
      notify(label, undo);
    } catch {
      setError("已保存，但刷新失败。请重新加载，不要重复提交。");
      notify(
        "已保存，但刷新失败",
        async () => {
          await refresh();
          setError("");
        },
        "重新加载",
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
    return result;
  }
  return { run, pending, error, setError };
}
