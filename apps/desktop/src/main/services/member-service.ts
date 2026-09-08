import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import ExcelJS from "exceljs";
import type { Member } from "../../shared/contracts";
import type { DatabaseStore } from "../database";

type MemberRow = {
  id: string;
  name: string;
  college: string;
  role: string;
  phone: string;
  student_id: string;
  major: string;
  grade: string;
  employee_no: string;
  active: number;
};

const HEADER_MAP: Record<string, keyof Omit<Member, "id" | "active">> = {
  姓名: "name",
  所属学院: "college",
  学院: "college",
  职务: "role",
  电话: "phone",
  短号: "phone",
  "电话/短号": "phone",
  学号: "studentId",
  专业: "major",
  年级: "grade",
  工号: "employeeNo",
};

function normalize(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .trim();
}

function toMember(row: MemberRow): Member {
  return {
    id: row.id,
    name: row.name,
    college: row.college,
    role: row.role,
    phone: row.phone,
    studentId: row.student_id,
    major: row.major,
    grade: row.grade,
    employeeNo: row.employee_no,
    active: row.active === 1,
  };
}

export class MemberService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly memberSourceDirectory?: string,
  ) {}

  list(activeOnly = true): Member[] {
    const rows = this.store
      .prepare(
        `SELECT * FROM members ${activeOnly ? "WHERE active = 1" : ""} ORDER BY name COLLATE NOCASE`,
      )
      .all() as unknown as MemberRow[];
    return rows.map(toMember);
  }

  get(id: string): Member | null {
    const row = this.store
      .prepare("SELECT * FROM members WHERE id = ?")
      .get(id) as MemberRow | undefined;
    return row ? toMember(row) : null;
  }

  findByExactName(name: string): Member[] {
    const rows = this.store
      .prepare(
        "SELECT * FROM members WHERE name = ? AND active = 1 ORDER BY id",
      )
      .all(name) as unknown as MemberRow[];
    return rows.map(toMember);
  }

  ensureMinimal(name: string): { member: Member; created: boolean } {
    const matches = this.findByExactName(name);
    if (matches.length === 1 && matches[0])
      return { member: matches[0], created: false };
    if (matches.length > 1)
      throw new Error(`存在多个同名成员“${name}”，请先在成员资料中明确选择`);
    return { member: this.save({ name }), created: true };
  }

  save(input: Partial<Member> & { name: string }): Member {
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    const existing = input.id ? this.get(input.id) : null;
    const values = {
      name: input.name.trim(),
      college: input.college ?? existing?.college ?? "",
      role: input.role ?? existing?.role ?? "",
      phone: input.phone ?? existing?.phone ?? "",
      studentId: input.studentId ?? existing?.studentId ?? "",
      major: input.major ?? existing?.major ?? "",
      grade: input.grade ?? existing?.grade ?? "",
      employeeNo: input.employeeNo ?? existing?.employeeNo ?? "",
      active: input.active ?? existing?.active ?? true,
    };
    if (!values.name) throw new Error("成员姓名不能为空");

    this.store
      .prepare(
        `
        INSERT INTO members (
          id, name, college, role, phone, student_id, major, grade, employee_no, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          college = excluded.college,
          role = excluded.role,
          phone = excluded.phone,
          student_id = excluded.student_id,
          major = excluded.major,
          grade = excluded.grade,
          employee_no = excluded.employee_no,
          active = excluded.active,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        id,
        values.name,
        values.college,
        values.role,
        values.phone,
        values.studentId,
        values.major,
        values.grade,
        values.employeeNo,
        values.active ? 1 : 0,
        existing
          ? (
              this.store
                .prepare("SELECT created_at FROM members WHERE id = ?")
                .get(id) as { created_at: string }
            ).created_at
          : now,
        now,
      );
    const saved = this.get(id);
    if (!saved) throw new Error("成员保存失败");
    return saved;
  }

  async parseWorkbook(
    filePath: string,
  ): Promise<Array<Partial<Member> & { name: string }>> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error("成员文件没有工作表");

    let headerRow = 0;
    const columns = new Map<number, keyof Omit<Member, "id" | "active">>();
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (headerRow) return;
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        const mapped = HEADER_MAP[normalize(cell.text)];
        if (mapped) columns.set(columnNumber, mapped);
      });
      if ([...columns.values()].includes("name")) headerRow = rowNumber;
      else columns.clear();
    });
    if (!headerRow) throw new Error("未找到包含“姓名”的成员表头");

    const inputs: Array<Partial<Member> & { name: string }> = [];
    for (
      let rowNumber = headerRow + 1;
      rowNumber <= worksheet.rowCount;
      rowNumber += 1
    ) {
      const row = worksheet.getRow(rowNumber);
      const input: Partial<Member> = {};
      for (const [column, key] of columns) {
        input[key] = row.getCell(column).text.trim();
      }
      if (input.name) inputs.push(input as Partial<Member> & { name: string });
    }
    if (inputs.length === 0) throw new Error("成员表中没有可导入人员");

    return inputs;
  }

  async importWorkbook(
    filePath: string,
    expectedRevision?: number,
    expectedHash?: string,
  ): Promise<{
    imported: number;
    created: number;
    updated: number;
    fileName: string;
  }> {
    const inputs = await this.parseWorkbook(filePath);
    const sourceFile = await readFile(filePath);
    const sourceSha256 = createHash("sha256").update(sourceFile).digest("hex");
    const importedAt = new Date().toISOString();
    let storedPath = filePath;
    if (this.memberSourceDirectory) {
      await mkdir(this.memberSourceDirectory, { recursive: true });
      storedPath = join(
        this.memberSourceDirectory,
        `${importedAt.replace(/[:.]/g, "-")}_${basename(filePath)}`,
      );
      await copyFile(filePath, storedPath);
    }

    if (expectedHash && sourceSha256 !== expectedHash)
      throw new Error("源文件已变化，请重新预览");
    if (
      expectedRevision !== undefined &&
      this.store.dataRevision() !== expectedRevision
    )
      throw new Error("数据已变化，请重新预览");
    let created = 0;
    let updated = 0;
    this.store.transaction(() => {
      for (const input of inputs) {
        const matches = this.findByExactName(input.name);
        if (matches.length > 1)
          throw new Error(`同名成员“${input.name}”无法自动合并`);
        if (matches[0]) {
          this.save({ ...matches[0], ...input, id: matches[0].id });
          updated += 1;
        } else {
          this.save(input);
          created += 1;
        }
      }
      this.store
        .prepare(
          `
          INSERT INTO member_imports(id, source_name, source_path, source_sha256, imported_at, row_count)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_sha256) DO UPDATE SET
            source_name = excluded.source_name,
            source_path = excluded.source_path,
            imported_at = excluded.imported_at,
            row_count = excluded.row_count
        `,
        )
        .run(
          randomUUID(),
          basename(filePath),
          storedPath,
          sourceSha256,
          importedAt,
          inputs.length,
        );
    });
    return {
      imported: inputs.length,
      created,
      updated,
      fileName: basename(filePath),
    };
  }
}
