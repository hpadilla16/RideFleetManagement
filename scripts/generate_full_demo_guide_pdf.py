from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "doc" / "ridefleet-full-demo-guide-2026-03-25.md"
OUTPUT = ROOT / "doc" / "Ride-Fleet-Full-Demo-Guide-2026-03-25.pdf"
LOGO = ROOT / "frontend" / "public" / "ride-logo.png"


def build_styles():
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="RideFleetKicker",
            parent=styles["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=9,
            leading=12,
            textColor=colors.HexColor("#6b42f5"),
            alignment=TA_CENTER,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="RideFleetTitle",
            parent=styles["Title"],
            fontName="Helvetica-Bold",
            fontSize=24,
            leading=30,
            textColor=colors.HexColor("#21314d"),
            alignment=TA_CENTER,
            spaceAfter=10,
        )
    )
    styles.add(
        ParagraphStyle(
            name="RideFleetSubtitle",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=11,
            leading=15,
            textColor=colors.HexColor("#4b5877"),
            alignment=TA_CENTER,
            spaceAfter=16,
        )
    )
    styles.add(
        ParagraphStyle(
            name="RideFleetHeading",
            parent=styles["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=14,
            leading=18,
            textColor=colors.HexColor("#5a38d6"),
            spaceBefore=10,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="RideFleetSubHeading",
            parent=styles["Heading3"],
            fontName="Helvetica-Bold",
            fontSize=11,
            leading=14,
            textColor=colors.HexColor("#21314d"),
            spaceBefore=6,
            spaceAfter=4,
        )
    )
    styles.add(
        ParagraphStyle(
            name="RideFleetBody",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=9.5,
            leading=13,
            textColor=colors.HexColor("#202638"),
            spaceAfter=4,
            alignment=TA_LEFT,
        )
    )
    styles.add(
        ParagraphStyle(
            name="RideFleetBullet",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=9.5,
            leading=13,
            leftIndent=14,
            bulletIndent=4,
            textColor=colors.HexColor("#202638"),
            spaceAfter=2,
        )
    )
    return styles


def page_decor(canvas, doc):
    page_w, page_h = letter
    canvas.saveState()
    canvas.setFillColor(colors.HexColor("#f6f2ff"))
    canvas.rect(0, page_h - 20, page_w, 20, fill=1, stroke=0)
    canvas.setFillColor(colors.HexColor("#6b42f5"))
    canvas.rect(0, page_h - 24, page_w, 4, fill=1, stroke=0)
    canvas.setFillColor(colors.HexColor("#6b42f5"))
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(doc.leftMargin, 18, "Ride Fleet Demo Guide")
    canvas.setFillColor(colors.HexColor("#6f7890"))
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(page_w - doc.rightMargin, 18, f"Page {canvas.getPageNumber()}")
    canvas.restoreState()


def markdown_to_story(text, styles):
    story = []
    title_seen = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            story.append(Spacer(1, 0.08 * inch))
            continue
        if line.startswith("# "):
            if not title_seen:
                title_seen = True
                if LOGO.exists():
                    story.append(Image(str(LOGO), width=1.6 * inch, height=1.6 * inch))
                    story.append(Spacer(1, 0.12 * inch))
                story.append(Paragraph("Ride Fleet", styles["RideFleetKicker"]))
                story.append(Paragraph(line[2:].strip(), styles["RideFleetTitle"]))
                story.append(
                    Paragraph(
                        "A branded walkthrough for product demos across booking, operations, support, car sharing, and dealership loaner.",
                        styles["RideFleetSubtitle"],
                    )
                )
                continue
            story.append(Paragraph(line[2:].strip(), styles["RideFleetHeading"]))
            continue
        if line.startswith("## "):
            story.append(Paragraph(line[3:].strip(), styles["RideFleetHeading"]))
            continue
        if line.startswith("### "):
            story.append(Paragraph(line[4:].strip(), styles["RideFleetSubHeading"]))
            continue
        if line.startswith("- "):
            safe = (
                line[2:].strip()
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
            )
            story.append(Paragraph(safe, styles["RideFleetBullet"], bulletText="•"))
            continue
        if len(line) > 3 and line[0].isdigit() and line[1:3] == ". ":
            safe = (
                line[3:].strip()
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
            )
            story.append(Paragraph(safe, styles["RideFleetBullet"], bulletText=f"{line[0]}." ))
            continue
        safe = line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        story.append(Paragraph(safe, styles["RideFleetBody"]))
    return story


def main():
    text = SOURCE.read_text(encoding="utf-8")
    styles = build_styles()
    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        leftMargin=0.7 * inch,
        rightMargin=0.7 * inch,
        topMargin=0.8 * inch,
        bottomMargin=0.55 * inch,
        title="Ride Fleet Full Demo Guide",
        author="OpenAI Codex",
    )
    story = markdown_to_story(text, styles)
    doc.build(story, onFirstPage=page_decor, onLaterPages=page_decor)
    print(OUTPUT)


if __name__ == "__main__":
    main()
