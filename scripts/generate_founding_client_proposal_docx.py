from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "doc" / "ridefleet-founding-client-proposal-2026-03-26.md"
OUTPUT = ROOT / "doc" / "Ride-Fleet-Founding-Client-Proposal-2026-03-26.docx"


def paragraph(text: str, style: str = "BodyRF") -> str:
    safe = escape(text)
    return (
        "<w:p>"
        f"<w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>"
        f"<w:r><w:t xml:space=\"preserve\">{safe}</w:t></w:r>"
        "</w:p>"
    )


def spacer() -> str:
    return (
        "<w:p>"
        "<w:pPr><w:spacing w:after=\"120\"/></w:pPr>"
        "</w:p>"
    )


def build_document_body(markdown_text: str) -> str:
    blocks: list[str] = []
    blocks.append(paragraph("Ride Fleet", "BrandRF"))
    blocks.append(paragraph("Founding Client Service Proposal", "HeroRF"))
    blocks.append(paragraph("Loaner Program + Optional Customer Service + Puerto Rico Tolls", "SubHeroRF"))
    blocks.append(spacer())

    for raw_line in markdown_text.splitlines():
        line = raw_line.strip()
        if not line:
            blocks.append(spacer())
            continue
        if line.startswith("# "):
            continue
        if line.startswith("## "):
            blocks.append(paragraph(line[3:].strip(), "Heading1RF"))
            continue
        if line.startswith("### "):
            blocks.append(paragraph(line[4:].strip(), "Heading2RF"))
            continue
        if line.startswith("- "):
            blocks.append(paragraph(f"• {line[2:].strip().replace('`', '')}", "BulletRF"))
            continue
        if len(line) > 3 and line[0].isdigit() and line[1] == "." and line[2] == " ":
            blocks.append(paragraph(line.replace("`", ""), "BulletRF"))
            continue
        blocks.append(paragraph(line.replace("`", ""), "BodyRF"))

    blocks.append(
        "<w:sectPr>"
        "<w:pgSz w:w=\"12240\" w:h=\"15840\"/>"
        "<w:pgMar w:top=\"1080\" w:right=\"900\" w:bottom=\"1080\" w:left=\"900\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/>"
        "</w:sectPr>"
    )
    return "".join(blocks)


def build_document_xml(markdown_text: str) -> str:
    body = build_document_body(markdown_text)
    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
        "<w:document xmlns:wpc=\"http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas\" "
        "xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" "
        "xmlns:o=\"urn:schemas-microsoft-com:office:office\" "
        "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" "
        "xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\" "
        "xmlns:v=\"urn:schemas-microsoft-com:vml\" "
        "xmlns:wp14=\"http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing\" "
        "xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" "
        "xmlns:w10=\"urn:schemas-microsoft-com:office:word\" "
        "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" "
        "xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\" "
        "xmlns:wpg=\"http://schemas.microsoft.com/office/word/2010/wordprocessingGroup\" "
        "xmlns:wpi=\"http://schemas.microsoft.com/office/word/2010/wordprocessingInk\" "
        "xmlns:wne=\"http://schemas.microsoft.com/office/word/2006/wordml\" "
        "xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\" "
        "mc:Ignorable=\"w14 wp14\">"
        f"<w:body>{body}</w:body>"
        "</w:document>"
    )


def styles_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
        <w:color w:val="202638"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>

  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:rPr>
      <w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
      <w:color w:val="202638"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="BrandRF">
    <w:name w:val="BrandRF"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:after="80"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:color w:val="7C3AED"/>
      <w:sz w:val="24"/>
      <w:szCs w:val="24"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="HeroRF">
    <w:name w:val="HeroRF"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:after="140"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:color w:val="2B3553"/>
      <w:sz w:val="34"/>
      <w:szCs w:val="34"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="SubHeroRF">
    <w:name w:val="SubHeroRF"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:after="220"/>
    </w:pPr>
    <w:rPr>
      <w:color w:val="5B647C"/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading1RF">
    <w:name w:val="Heading1RF"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="220" w:after="90"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:color w:val="7C3AED"/>
      <w:sz w:val="28"/>
      <w:szCs w:val="28"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="Heading2RF">
    <w:name w:val="Heading2RF"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="140" w:after="70"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:color w:val="2B3553"/>
      <w:sz w:val="24"/>
      <w:szCs w:val="24"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="BodyRF">
    <w:name w:val="BodyRF"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:after="55" w:line="300" w:lineRule="auto"/>
    </w:pPr>
    <w:rPr>
      <w:color w:val="202638"/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="BulletRF">
    <w:name w:val="BulletRF"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:ind w:left="420" w:hanging="0"/>
      <w:spacing w:after="40" w:line="280" w:lineRule="auto"/>
    </w:pPr>
    <w:rPr>
      <w:color w:val="202638"/>
      <w:sz w:val="22"/>
      <w:szCs w:val="22"/>
    </w:rPr>
  </w:style>
</w:styles>
"""


def content_types_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
"""


def rels_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
"""


def document_rels_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
"""


def core_xml() -> str:
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:dcmitype="http://purl.org/dc/dcmitype/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Ride Fleet Founding Client Proposal</dc:title>
  <dc:subject>Dealership Loaner Proposal</dc:subject>
  <dc:creator>OpenAI Codex</dc:creator>
  <cp:keywords>Ride Fleet, Proposal, Loaner Program</cp:keywords>
  <dc:description>Founding client service proposal for a dealership loaner operation.</dc:description>
  <cp:lastModifiedBy>OpenAI Codex</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>
</cp:coreProperties>
"""


def app_xml() -> str:
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Microsoft Office Word</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <Company>Ride Fleet</Company>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>16.0000</AppVersion>
</Properties>
"""


def main() -> None:
    markdown_text = SOURCE.read_text(encoding="utf-8")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED) as docx:
      docx.writestr("[Content_Types].xml", content_types_xml())
      docx.writestr("_rels/.rels", rels_xml())
      docx.writestr("docProps/core.xml", core_xml())
      docx.writestr("docProps/app.xml", app_xml())
      docx.writestr("word/document.xml", build_document_xml(markdown_text))
      docx.writestr("word/styles.xml", styles_xml())
      docx.writestr("word/_rels/document.xml.rels", document_rels_xml())

    print(OUTPUT)


if __name__ == "__main__":
    main()
