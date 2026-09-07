"""Build the teacher/student PDF manual from verified 0.5.0 UI screenshots."""
from pathlib import Path
import sys
import json
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tmp/pdf-deps'))
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle, PageBreak
from pypdf import PdfReader
from PIL import Image as PILImage

OUT = ROOT / 'output/pdf/暨南大学网络服务小组功能手册与操作指南_0.5.0.pdf'
OUT.parent.mkdir(parents=True, exist_ok=True)
SHOTS = ROOT / 'docs/manual/screenshots'
pdfmetrics.registerFont(TTFont('YaHei', 'C:/Windows/Fonts/msyh.ttc', subfontIndex=0))
pdfmetrics.registerFont(TTFont('YaHeiBold', 'C:/Windows/Fonts/msyhbd.ttc', subfontIndex=0))
pdfmetrics.registerFontFamily('YaHei', normal='YaHei', bold='YaHeiBold')
W = A4[0] - 76
styles = {
    'title': ParagraphStyle('title', fontName='YaHeiBold', fontSize=24, leading=34, textColor=colors.black, spaceAfter=12, wordWrap='CJK'),
    'h1': ParagraphStyle('h1', fontName='YaHeiBold', fontSize=19, leading=28, textColor=colors.black, spaceAfter=10, wordWrap='CJK'),
    'h2': ParagraphStyle('h2', fontName='YaHeiBold', fontSize=12, leading=19, spaceBefore=10, spaceAfter=5, wordWrap='CJK', keepWithNext=True),
    'body': ParagraphStyle('body', fontName='YaHei', fontSize=10.5, leading=17.5, spaceAfter=7, wordWrap='CJK'),
    'small': ParagraphStyle('small', fontName='YaHei', fontSize=9, leading=14.5, textColor=colors.HexColor('#555555'), spaceAfter=8, wordWrap='CJK'),
    'caption': ParagraphStyle('caption', fontName='YaHei', fontSize=8.5, leading=13, textColor=colors.HexColor('#555555'), spaceBefore=5, spaceAfter=12, wordWrap='CJK'),
    'cell': ParagraphStyle('cell', fontName='YaHei', fontSize=9.5, leading=15, wordWrap='CJK'),
}
story = []
page_titles = []

def p(text, style='body'):
    story.append(Paragraph(text, styles[style]))

def heading(title):
    if story:
        story.append(PageBreak())
    page_titles.append(title)
    item = Paragraph(title, styles['h1'])
    item.bookmark = f'p{len(page_titles)}'
    story.append(item)

def steps(*items):
    for i, text in enumerate(items, 1):
        p(f'{i}. {text}')

def shot(name, caption, max_height=350):
    path = SHOTS / f'{name}.png'
    with PILImage.open(path) as im:
        width, height = im.size
    ratio = min(W/width, max_height/height)
    story.append(Image(str(path), width=width*ratio, height=height*ratio, hAlign='LEFT'))
    p(caption, 'caption')

def table(rows, widths):
    cells = [[Paragraph(escape(str(cell)), styles['cell']) for cell in row] for row in rows]
    item = Table(cells, colWidths=[W*x for x in widths], repeatRows=1, hAlign='LEFT')
    item.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),colors.HexColor('#EDF2F7')),
        ('GRID',(0,0),(-1,-1),0.5,colors.HexColor('#D9D9D9')),
        ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
        ('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),
        ('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),
    ]))
    story.append(item)
    story.append(Spacer(1,10))

heading('暨南大学网络服务小组功能手册与操作指南')
p('适用版本 0.5.0　｜　2026 年 9 月', 'small')
p('同学可按本手册完成签到、查看班表和核对工时。老师或负责同学可完成排班导入、签到改错、月报导出和备份恢复。')
p('第一次使用', 'h2')
steps('双击老师或负责同学提供的安装包，按提示完成安装，打开“暨南大学网络服务小组签到与月报”。',
      '进入“排班与成员”，导入成员信息表和正式排班，核对月份、生效日期与人员。',
      '进入“设置”，选择默认导出目录和备份目录，按需开启开机自启动。',
      '回到“签到”查看当天班次。到班后选择实际到场人员并签到。')
p('按任务查找', 'h2')
table([
 ['使用任务','界面入口','页码'],
 ['当天签到与临时替班','签到','2'],
 ['请假、加班与单次增员','请假与加班','3'],
 ['查看班表和工时','看板','4–5'],
 ['导入排班和维护成员','排班与成员','6–7'],
 ['补记签到和更正记录','签到记录','8–9'],
 ['填写评分并导出月报','输出本月绩效文件','10–13'],
 ['设置目录、文件与更新','设置','14–16'],
 ['备份与恢复','设置 → 备份管理','17'],
 ['常见问题与交接检查','按问题查找','18'],
], [0.43,0.42,0.15])
p('截图中的姓名、班次和工时为操作示例。实际使用时，以当月排班及本人记录为准。', 'small')

heading('2　当天签到与临时替班')
steps('点击顶部“签到”，找到正在进行的班次，核对起止时间和负责人。',
      '确认下拉框中的姓名为实际到场人员。多人班次还需勾选对应席位；“席位”表示本班的一名值班人员。',
      '点击“签到”或“为所选 N 人签到”。确认姓名旁出现打卡时间，右上角已签到人数增加。')
shot('02-选择到场人员','图 1　勾选实际到场人员后提交签到',160)
shot('03-签到成功','图 2　签到完成后显示姓名、打卡时间和已签到人数',160)
p('临时替班', 'h2')
p('在原负责人的席位中选择替班同学的姓名，再提交签到。工时计给实际签到人员。多人班次中，同一个人只能选择一个席位。')
p('时间与工时', 'h2')
p('“距结束”显示当前班次剩余时间。未开始和已结束的班次无法直接签到。班内签到按本班完整工时记录，无需签退；同时承担不同班次时，各班分别签到、分别计算工时。')

heading('3　请假 加班与单次增员')
shot('19-请假与加班','图 3　指定代班并为所选单次班次添加办公人员',150)
shot('21-加班安排','图 4　加班按自定义时段安排，签到后才计薪',165)
steps('点击“请假与加班”，先选择要办理的日期。',
      '请假时找到原排班人员，点击“办理请假”；可选择代班人并填写原因。无代班请假不计缺勤，指定代班后只能由该人员签到。',
      '需要为某个具体班次增加办公人员时，在班次底部选择成员并点击“添加”。该安排不会影响其他日期。',
      '添加加班时选择人员和同日开始、结束时间。加班安排本身不产生工时；当天在加班时段签到，历史加班到“签到记录”补记。')
p('代班或加班已经签到后，需先撤销对应签到，才能撤销请假或加班。排班 Word 仍只显示正式 Excel 排班；已计薪加班会进入看板、工资工作量和对应成员的工时 Excel 明细。', 'small')

heading('4　查看一周班表')
shot('04-周班表','图 5　周班表显示正式班、办公人员、请假代班和加班',345)
steps('点击“看板”。点击周班表的左右箭头切换周次，点击“今天”回到本周。',
      '沿时间轴上下滚动，查看班次时间、负责人和到岗状态。',
      '需要查找某类班次或某位同学时，使用上方“班次”和“成员”筛选。')
table([['颜色','含义'],['绿色 到岗','该席位已签到。'],['红色 未到岗','正式班已开始，该席位尚未签到。'],['灰色 未到班','班次尚未开始。'],['黄色 请假','无代班请假，已从缺勤统计中豁免。']],[0.28,0.72])
p('顶部日期范围用于下方工时汇总；周班表的显示日期由左右箭头单独切换。', 'small')

heading('5　核对出勤与工时')
shot('05-工时汇总','图 6　核对常规工时、加班工时、总工时和请假',340)
steps('在“看板”选择“今日”“本月”或“考核周期”，也可直接填写开始、结束日期。',
      '在“成员”中选择本人，核对坐班工时、维修工时、总工时及迟到次数。',
      '需要确认具体记录时，向下查看“签到明细”，核对原排班、实际人员和打卡时间。')
p('到岗率只统计已结束班次；正在进行及尚未开始的班次不计入分母。红色表示当前尚未签到，不能单凭颜色判断整班缺勤。')
p('工时按有效签到的班次累加。撤销记录后，该条记录不再计入工时；发现错误时按第 9 页处理。')

heading('6　导入排班和成员信息')
shot('06-导入排班和成员','图 7　在“排班与成员”导入 Excel 文件',340)
steps('点击“排班与成员”，再点击“选择成员信息表”，选中老师提供的 Excel。导入后核对新增、更新人数。',
      '在“导入正式排班”填写“排班月份”和“生效日期”。',
      '点击“选择排班文件”，选择对应月份的 Excel。等待“排班导入成功”，检查班次数量和提示信息。',
      '进入“看板”，抽查工作日坐班、维修班及周末坐班的时间和负责人。')
p('调整排班', 'h2')
p('先修改原 Excel，再选择生效日期重新导入。调整后的排班请逐日核对；涉及已经开始或已有签到的班次时，先联系负责老师确认处理方式。')
p('成员表至少包含“姓名”列；学院、职务、学号等可随后补齐。排班文件请沿用老师提供的格式。解析失败时，根据提示修改文件后重试。')

heading('7　维护成员资料和签到规则')
shot('07-编辑成员','图 8　编辑成员资料',150)
steps('在“排班与成员”的“成员资料”中点击姓名，修改学院、职务、学号等信息，然后点击“保存”。',
      '新增人员时点击“新增成员”，填写姓名和资料后保存。出现同名人员时，先请负责老师核对，避免签到选错。')
shot('08-签到与迟到设置','图 9　签到模式、迟到时间和建议扣分',180)
p('签到与迟到设置', 'h2')
p('由负责老师确定规则：选择“宽松模式”或“迟到标记模式”，填写开班后多少分钟算迟到、每次迟到建议扣分，再点击“保存设置”。')
p('宽松模式下，班内签到不标记迟到。迟到标记模式会按设置的时间判断。新设置应用于尚未开始且没有签到记录的班次，已有记录保持原结果。')
p('默认使用宽松模式；迟到时间默认 15 分钟，每次迟到建议扣 1 分。月报中的考勤建议分可由老师核对后修改。')

heading('8　补记漏签')
p('漏签后，请先由负责老师或负责同学核实实际出勤，再补记。')
shot('17-补记表单','图 10　选择班次席位和实际人员后保存补记',220)
steps('点击顶部“签到记录”，找到“补记签到”。',
      '选择“班次日期”，在“班次席位”中选择未签到的席位，核对时间和原排班人员。',
      '选择“实际人员”。如有准确记录，填写“历史打卡时刻”；无法确认时留空。',
      '点击“保存补记”，再到下方“记录明细”核对姓名、班次和工时。')
p('填写要求', 'h2')
p('只补记已经实际出勤的班次。填写历史时间时，核对日期、小时和分钟；当前版本不会完整拦截未来班次或班次外的历史时间。')
p('历史打卡时刻留空时，状态显示“补记未判定”，工时仍按本班完整时长计算。补记前确认同一人没有在该班其他席位签到。')

heading('9　更正 撤销和恢复签到记录')
shot('18-记录明细','图 11　记录明细中的人员更正、撤销与恢复入口',365)
p('选错了实际人员', 'h2')
steps('在“签到记录”设置日期范围，找到对应记录。',
      '在该行“实际人员”下拉框选择正确姓名，点击出现的“保存更正”。')
p('误签或误撤销', 'h2')
p('误签时点击该行“撤销”；撤销后，记录显示“已撤销”并停止计入工时。误撤销时点击“恢复”。如果该席位或人员已经有另一条有效签到，需要先核对两条记录。')
p('需要更正打卡时间', 'h2')
p('当前页面不能直接修改打卡时间。由负责老师核实后，撤销错误记录，再按第 8 页补记正确时间。')
p('改错后，重新进入“看板”和月报页面核对结果。此前已导出的文件需要重新导出。', 'small')

heading('10　填写月报信息并导出')
shot('10-月报信息与文件清单','图 12　本月信息和文件清单',340)
steps('点击“输出本月绩效文件”，确认所属年份、月份、填写日期和填表人。',
      '核对“统计开始”和“统计结束”。默认考核周期为上月 26 日至本月 25 日，可按老师要求调整。',
      '在“输出目录”点击“选择”，确定文件保存位置。',
      '点击“文件清单”中的名称，逐项填写工作报表、绩效评分和工资工作量。勾选本次需要导出的文件。',
      '确认右上角显示“已保存”，点击“导出所选 N 个文件”。生成后打开导出文件夹。')
p('导出后打开文件，检查人员、日期、工时和版面。若提示某个文件生成失败，处理提示中的问题后重新导出。每次导出会建立独立文件夹。')

heading('11　填写部门工作报表')
shot('11-工作报表编辑','图 13　“完成的工作”可填写多条内容',215)
steps('在“文件清单”点击“部门工作报表”。',
      '填写“完成的工作”，每条写清本月完成的事项。',
      '在“问题与反思对策”中对应填写问题和处理办法。',
      '继续向下填写“下月安排”和“意见建议”。修改后等待右上角显示“已保存”。')
p('填写示例', 'h2')
table([
 ['栏目','示例'],
 ['完成的工作','完成值班接待和校园网络报修登记。'],
 ['问题','部分报修登记缺少房间号。'],
 ['反思和对策','接单时补齐位置、联系方式和故障现象。'],
 ['下月安排','继续做好日常值班，更新常见问题解答。'],
], [0.25,0.75])
p('各组提供三条输入位置，可在输入框内换行。填写内容较多时，向下滚动继续编辑。导出前核对内容预览。')

heading('12　核对绩效评分')
shot('12-绩效评分','图 14　逐人修改评分，可填写优秀员工推荐',335)
steps('在“文件清单”点击“全员绩效考核表”。',
      '先核对姓名下方的工时和迟到次数，再填写考勤、工时、自评、互评、负责人及活动分。',
      '需要推荐优秀员工时，在下方选择人员并填写原因；没有推荐时保留“不推荐”。',
      '等待“已保存”，检查总分和内容预览。')
p('分值范围', 'h2')
p('考勤 0–30 分，工时 0–10 分，自评 0–10 分，互评 0–20 分，负责人 0–30 分，活动 0–5 分；总分最高 100 分。')
p('系统按迟到次数生成考勤建议分，活动分默认 0，其余项目默认满分。请按实际表现核对。任一评分留空时，总分显示“—”；老师修改后的分值会保留。')

heading('13　核对工资工作量和工时文件')
shot('13-工资工作量','图 15　工资考核表同时显示系统工时和可编辑的工作量',300)
steps('在“文件清单”点击“工资考核表”。',
      '核对“系统工时”和“工作量”。工作量默认使用系统工时，以 h 表示小时，例如 8h。',
      '需要调整时，在“工作量”中填写老师确认的数值，备注中写明原因，等待“已保存”。')
p('修改工作量只影响工资考核表。工时记录表继续采用签到计算结果，已签到或补记的加班会像普通班次一样进入对应成员的日期、开始、结束和工时明细，工时使用 h。')
p('其他输出文件', 'h2')
table([
 ['文件','格式','检查内容'],
 ['团队工时记录表','Excel','系统按有效签到生成；核对统计周期、姓名和工时。'],
 ['正式排班表','Word','导入的原始排班 Excel 表格写入文档；核对月份和来源文件。'],
 ['部门工作报表 绩效考核表 工资考核表','Word','核对文字、评分、工作量和填表信息。'],
], [0.30,0.13,0.57])

heading('14　设置自启动和文件目录')
shot('14-系统与文件位置','图 16　开机自启动和文件位置设置',345)
p('开机自启动', 'h2')
p('点击顶部“设置”，勾选“开机自启动”，下次登录 Windows 后自动打开软件。取消勾选即可关闭。')
p('修改保存位置', 'h2')
steps('找到“默认导出目录”或“备份目录”，点击右侧“更改”。',
      '选择一个专用文件夹并确认。看到路径更新后，点击“打开”检查位置。')
p('默认导出目录用于新月份的月报。已保存月份的目录可在月报页面单独修改。更换备份目录后，旧备份仍在原文件夹。')
p('“应用数据”和“输出模板”支持查看及打开，不能在此页面更改位置。请保留文件夹中的原有文件。', 'small')

heading('15　查看当前使用的文件')
shot('15-当前使用文件','图 17　查看排班、员工资料和输出模板的文件名及状态',315)
steps('进入“设置”，向下找到“当前使用的文件”。',
      '按“用途”查找当前排班、员工资料或输出模板，核对文件名和导入时间。',
      '点击该行“打开”查看文件。显示“缺失”时，联系负责同学检查文件位置或重新导入。')
p('如何确认正在使用哪份排班', 'h2')
p('“当前排班”列出仍有生效班次的文件。调整过排班后，可能同时显示多份来源；结合生效信息，到“看板”核对具体日期。')
p('成员信息与文件更新', 'h2')
p('“员工资料”显示最近导入的成员表。排班和成员文件导入后会保留副本；修改外部 Excel 后，需要重新导入才能更新软件中的内容。')
p('旧版升级后若显示“旧版本未记录来源，请重新导入员工文件”，可重新导入原成员表。原有成员资料仍然保留。')

heading('16　检查与安装更新')
shot('20-更新设置','图 18　选择手动或自动更新并查看下载状态',205)
p('默认使用“手动更新”，软件不会主动联网。点击“检查更新”，发现新版后点击“下载”；下载完成后，由用户确认“重启并安装”。')
p('“自动检查与下载”只在窗口启动完成后检查一次，发现稳定版后在后台下载，不会强制退出或高频轮询。开发版显示不支持更新。0.4.0 需要先手动安装一次 0.5.0，此后版本才可使用自动更新。', 'small')

heading('17　备份与恢复')
shot('16-备份管理','图 19　备份列表显示时间、类型和是否完整',200)
p('创建备份', 'h2')
steps('进入“设置”，找到“备份管理”，点击“立即备份”。',
      '看到“备份完成”后，在列表中确认新增备份显示“完整”。',
      '需要留存到其他设备时，点击“打开备份目录”，复制完整的单份备份文件夹。')
p('软件在每日首次启动时自动备份，当前目录最多保留最近 30 份。备份目录请使用专用文件夹。已导出的月报请单独归档。')
p('恢复备份', 'h2')
steps('先保存正在编辑的内容。在列表中按时间选择要恢复的完整备份，点击“恢复”。',
      '阅读确认提示后继续。软件先保存一份恢复前备份，再恢复所选数据并重启。',
      '重启后检查成员、排班、签到记录、月报草稿，以及输出目录和备份目录。')
p('恢复会将当前数据替换为备份时的数据。需要恢复旧目录或其他设备上的备份时，点击“从其他位置恢复”，选择包含 manifest.json 的那一份备份文件夹。')
p('备份包含应用数据、排班和成员文件副本，以及输出模板副本。自动恢复会补回排班与成员文件，软件继续使用当前安装版本的输出模板。跨电脑恢复后若来源文件仍显示缺失，请核对留存副本并重新导入。', 'small')

heading('18　常见问题与交接检查')
p('今天没有班次', 'h2')
p('先核对电脑日期，再检查排班月份和生效日期。在“看板”切换到当天所在周；如果确实没有排班，请联系负责同学确认。')
p('签到按钮不能点', 'h2')
p('确认已到本班签到时间；多人班次需勾选席位并选择姓名。班次结束后，联系负责老师核实并补记。')
p('提示同一人不能重复签到', 'h2')
p('检查是否在本班的其他席位选了同一人，或该人已经签到。到“签到记录”核对已有记录。')
p('工时与预期不一致', 'h2')
p('核对统计起止日期、实际人员和记录是否被撤销。一个人承担不同班次时，工时会分别累加。若工资表工作量曾手动修改，也需单独核对。')
p('导出按钮不能点或生成失败', 'h2')
p('确认已选择输出目录并勾选文件。检查错误提示、目录是否可用、模板是否缺失；导出后核对实际生成的文件数量。')
p('备份显示损坏', 'h2')
p('该备份不能恢复。选择其他显示“完整”的备份；复制备份时保留整个文件夹。')
p('学期或人员交接时', 'h2')
steps('核对当月成员资料、正式排班和有效签到。',
      '导出并检查本期月报，确认保存位置。',
      '点击“立即备份”，将完整备份文件夹和已导出的月报分别留存。',
      '告知接手同学排班源文件、成员文件、输出目录和备份目录的位置。')

class ManualDoc(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if getattr(flowable,'bookmark',None):
            self.canv.bookmarkPage(flowable.bookmark)
            self.canv.addOutlineEntry(flowable.getPlainText(),flowable.bookmark,level=0,closed=False)

def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('YaHei',8)
    canvas.setFillColor(colors.HexColor('#666666'))
    canvas.drawString(38,22,'暨南大学网络服务小组  ·  功能手册与操作指南  ·  0.5.0')
    canvas.drawRightString(A4[0]-38,22,str(doc.page))
    canvas.restoreState()

doc = ManualDoc(str(OUT),pagesize=A4,rightMargin=38,leftMargin=38,topMargin=32,bottomMargin=42,
                title='暨南大学网络服务小组功能手册与操作指南',author='暨南大学网络服务小组',pageCompression=1)
doc.build(story,onFirstPage=footer,onLaterPages=footer)
reader=PdfReader(str(OUT))
assert len(reader.pages)==len(page_titles),f'Unexpected overflow: {len(reader.pages)} pages for {len(page_titles)} sections'
for i,(page,title) in enumerate(zip(reader.pages,page_titles),1):
    text=page.extract_text()
    assert ''.join(title.split()) in ''.join(text.split()),f'Heading mismatch on page {i}'
    assert '不是' not in text and '而是' not in text
report={'path':str(OUT),'pages':len(reader.pages),'images':sum(len(page.images) for page in reader.pages),'bytes':OUT.stat().st_size,'titles':page_titles}
(ROOT/'.tmp/manual-pdf-check.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(report,ensure_ascii=False,indent=2))
