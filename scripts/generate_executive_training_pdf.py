from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "doc" / "ridefleet-executive-training-guide-2026-03-25.md"
OUTPUT = ROOT / "doc" / "Ride-Fleet-Executive-Training-Guide-2026-03-25.pdf"


def build_styles():
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="TitleRideFleet",
            parent=styles["Title"],
            fontName="Helvetica-Bold",
            fontSize=22,
            leading=28,
            textColor=colors.HexColor("#2b3553"),
            spaceAfter=12,
            alignment=TA_LEFT,
        )
    )
    styles.add(
        ParagraphStyle(
            name="HeadingRideFleet",
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
            name="SubHeadingRideFleet",
            parent=styles["Heading3"],
            fontName="Helvetica-Bold",
            fontSize=11,
            leading=14,
            textColor=colors.HexColor("#2b3553"),
            spaceBefore=6,
            spaceAfter=4,
        )
    )
    styles.add(
        ParagraphStyle(
            name="BodyRideFleet",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=9.5,
            leading=13,
            textColor=colors.HexColor("#202638"),
            spaceAfter=4,
        )
    )
    styles.add(
        ParagraphStyle(
            name="BulletRideFleet",
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


def markdown_to_story(text, styles):
    story = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            story.append(Spacer(1, 0.08 * inch))
            continue
        if line.startswith("# "):
            story.append(Paragraph(line[2:].strip(), styles["TitleRideFleet"]))
            continue
        if line.startswith("## "):
            story.append(Paragraph(line[3:].strip(), styles["HeadingRideFleet"]))
            continue
        if line.startswith("### "):
            story.append(Paragraph(line[4:].strip(), styles["SubHeadingRideFleet"]))
            continue
        if line.startswith("- "):
            story.append(Paragraph(line[2:].strip(), styles["BulletRideFleet"], bulletText="•"))
            continue
        if line[:2].isdigit() and line[1:3] == ". ":
            story.append(Paragraph(line[3:].strip(), styles["BulletRideFleet"], bulletText=f"{line[0]}."))
            continue
        safe = (
            line.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )
        story.append(Paragraph(safe, styles["BodyRideFleet"]))
    return story


def main():
    text = SOURCE.read_text(encoding="utf-8")
    styles = build_styles()
    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        leftMargin=0.7 * inch,
        rightMargin=0.7 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
        title="Ride Fleet Executive Training Guide",
        author="OpenAI Codex",
    )
    story = markdown_to_story(text, styles)
    doc.build(story)
    print(OUTPUT)


if __name__ == "__main__":
    main()
