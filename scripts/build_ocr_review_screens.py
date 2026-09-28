#!/usr/bin/env python3
"""Generate review-only Canvas screen shells; never connect writes or sends."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'powerapps' / 'CN_AI依頼台帳' / 'Source'

def label(name, value, y, height=70, size=15, accent=False):
    color = 'RGBA(0, 204, 102, 1)' if accent else 'RGBA(255, 255, 255, 1)'
    value = value.replace('"', '""')
    return f'''      - {name}:
          Control: Label@2.5.1
          Properties:
            Color: ={color}
            Height: ={height}
            Size: ={size}
            Text: ="{value}"
            Width: =Parent.Width - 32
            X: =16
            Y: ={y}
'''

def button(name, value, y, target=None):
    value = value.replace('"', '""')
    behavior = ('OnSelect: =Back()' if target == 'BACK' else
                f'OnSelect: =Navigate({target}, ScreenTransition.None)' if target else
                'DisplayMode: =DisplayMode.Disabled')
    return f'''      - {name}:
          Control: Classic/Button@2.2.0
          Properties:
            Color: =RGBA(10, 10, 10, 1)
            Fill: =RGBA(0, 204, 102, 1)
            Height: =44
            {behavior}
            Text: ="{value}"
            Width: =Parent.Width - 32
            X: =16
            Y: ={y}
'''

def screen(name, title, note, links, back, title_expression=None, details=()):
    content = f'''Screens:
  {name}:
    Properties:
      Fill: =RGBA(10, 10, 10, 1)
    Children:
'''
    heading = label(name + '_Title', title, 16, 52, 20, True)
    if title_expression:
        heading = heading.replace(f'Text: ="{title}"', f'Text: ={title_expression}')
    content += heading
    content += button(name + '_Back', '戻る', 76, back)
    content += label(name + '_Note', note, 136, 125)
    for i, (caption, target) in enumerate(links):
        content += button(name + f'_Action{i+1}', caption, 278 + 54*i, target)
    for i, detail in enumerate(details):
        content += label(name + f'_Field{i+1}', detail, 402 + 44*i, 40, 14)
    (ROOT / (name + '.pa.yaml')).write_text(content, encoding='utf-8')

screen('S16_OperationsHub', '運営管理',
       '自社情報と月次経理の入口です。管理者向けの画面として準備中です。',
       [('自社情報・OCR', 'S17_CompanyInfoOCR'), ('月次経理', 'S15_OperationsMonthly')],
       'S1_Home')
screen('S17_CompanyInfoOCR', '自社情報・OCR',
       '会社の書類から会社名・所在地・連絡先などの候補を読み取り、確認します。現在は保存できません。',
       [('OCR読取プレビュー', 'S18_OcrReadPreview'), ('自社情報を保存（接続待ち）', None)],
       'S16_OperationsHub', details=('会社名：未取得', '所在地：未取得', '連絡先：未取得'))
screen('S18_OcrReadPreview', 'OCR 読取プレビュー',
       '元画像と読取候補、登録済み情報との差分を項目ごとに確認します。読取機能の準備が整うまで候補を確定できません。',
       [('読取結果を確定（接続待ち）', None), ('完成帳票プレビュー', 'S19_OcrFinalPreview')],
       'BACK', details=('元画像：未選択', '読取候補：なし', '要確認項目：読取待ち'))
screen('S19_OcrFinalPreview', '完成帳票プレビュー',
       '自動記載後の帳票、宛先、金額、添付を確認します。完成版を確認できるまでPDF出力とFAX送信はできません。',
       [('PDF出力（接続待ち）', None), ('FAX送信（接続待ち）', None)],
       'BACK', details=('送付先：未設定', '完成帳票：未生成', '確認者：未確認'))
screen('S20_MonthlyPL', '月次損益表',
       '売上・費用・利益を確認する下書き画面です。帳簿との照合が済むまで金額とPDF出力は表示しません。',
       [('損益表PDF（照合待ち）', None), ('貸借対照表を見る', 'S21_MonthlyBS')],
       'S15_OperationsMonthly', details=('売上高：未集計', '費用：未集計', '当月損益：未算定'))
screen('S21_MonthlyBS', '月次貸借対照表',
       '資産・負債・純資産と累計利益を確認する下書き画面です。期首残高と預金の照合が済むまで金額は表示しません。',
       [('貸借対照表PDF（照合待ち）', None), ('損益表を見る', 'S20_MonthlyPL')],
       'S15_OperationsMonthly', details=('資産：未集計', '負債：未集計', '純資産：未集計'))
screen('S22_ReceiptCapture', '領収書・明細を日付に貼る',
       '選択したカレンダーの日付へ写真またはPDFを貼り付けます。添付機能の準備が整うまで登録と集計はできません。',
       [('写真・PDFを選ぶ（接続待ち）', None), ('OCR読取（接続待ち）', None)],
       'S14_DateDocuments',
       'Text(gblSelDate, "yyyy年m月d日") & " の領収書・明細"',
       details=('写真・PDF：未選択', '金額・費目：未確認', '保存状態：未登録'))
