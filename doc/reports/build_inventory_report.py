"""
Inventory reconciliation report for International Rental Corp.
Generated 2026-05-27 — to be used during the lot walk-through tomorrow.
"""

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER

OUT_PATH = "/sessions/quirky-vigilant-mccarthy/mnt/RideFleetManagement/doc/reports/2026-05-27-inventory-reconciliation.pdf"

# ---------------------------------------------------------------------------
# Styles
# ---------------------------------------------------------------------------
styles = getSampleStyleSheet()
title_style = ParagraphStyle(
    'TitleStyle', parent=styles['Title'],
    fontSize=22, leading=26, spaceAfter=8, textColor=colors.HexColor('#1F2937'),
)
subtitle_style = ParagraphStyle(
    'Subtitle', parent=styles['Normal'],
    fontSize=12, textColor=colors.HexColor('#6B7280'), spaceAfter=20,
)
h1 = ParagraphStyle(
    'H1', parent=styles['Heading1'],
    fontSize=15, leading=18, spaceBefore=14, spaceAfter=8,
    textColor=colors.HexColor('#111827'),
)
h2 = ParagraphStyle(
    'H2', parent=styles['Heading2'],
    fontSize=12, leading=15, spaceBefore=10, spaceAfter=6,
    textColor=colors.HexColor('#374151'),
)
body = ParagraphStyle(
    'Body', parent=styles['Normal'],
    fontSize=10, leading=14, spaceAfter=6, textColor=colors.HexColor('#1F2937'),
)
small = ParagraphStyle(
    'Small', parent=styles['Normal'],
    fontSize=8, leading=10, textColor=colors.HexColor('#4B5563'),
)
mono = ParagraphStyle(
    'Mono', parent=styles['Code'],
    fontSize=8, leading=10, fontName='Courier', textColor=colors.HexColor('#1F2937'),
    leftIndent=10, spaceBefore=4, spaceAfter=6,
)
callout = ParagraphStyle(
    'Callout', parent=styles['Normal'],
    fontSize=10, leading=14, textColor=colors.HexColor('#92400E'),
    backColor=colors.HexColor('#FEF3C7'), borderPadding=8,
    borderColor=colors.HexColor('#F59E0B'), borderWidth=0.5,
    spaceAfter=10,
)

# ---------------------------------------------------------------------------
# Data — captured from the SQL diagnostics run earlier today
# ---------------------------------------------------------------------------
BUCKET_A = [
    # (reservation, customer, plate, vehicle, picked_up, due_back, extended_note)
    ("RES-301828", "Zoe Sanchez", "KJH-490", "Hyundai Kona", "2026-05-22", "2026-05-28 14:00", ""),
    ("RES-514147", "Alpesh Kothari", "KLK-104", "Toyota Corolla Cross", "2026-05-21", "2026-05-28 16:00", ""),
    ("RES-157173", "Marisol Olivera", "KJH-486", "Hyundai Elantra", "2026-05-19", "2026-05-28 17:00", ""),
    ("RES-867597", "FAJR AHMAD", "KMR719", "Dodge Durango", "2026-05-21", "2026-05-28 18:07", ""),
    ("RES-593864", "Tygee Ramos", "KQN-821", "Nissan Kicks", "2026-05-21", "2026-05-28 23:30", ""),
    ("RES-061350", "DESERAE HERNANDEZ", "KHJ521", "Nissan Versa", "2026-05-23", "2026-05-29 04:00", ""),
    ("RES-506794", "Jessica Erron", "KFZ-616", "Chrysler Pacifica", "2026-05-25", "2026-05-29 16:00", ""),
    ("RES-444864", "Aurea M Avelar", "KQN765", "Nissan Kicks", "2026-05-24", "2026-05-29 16:00", ""),
    ("RES-139883", "Louis Rodriguez", "KNB778", "Toyota Sienna", "2026-05-24", "2026-05-29 16:30", ""),
    ("RES-230558", "Juan Pablo Correa", "KHV165", "Hyundai Venue", "2026-05-21", "2026-05-29 16:50", ""),
    ("RES-538241", "Rebecca Mercado", "KHC511", "Nissan Versa", "2026-05-24", "2026-05-29 18:00", "** plate conflict"),
    ("RES-440252", "Alfonso Gonzalez", "KHD245", "Hyundai Venue", "2026-05-20", "2026-05-29 19:00", ""),
    ("RES-833444", "Naomi Diaz", "KQN772", "Nissan Kicks", "2026-05-20", "2026-05-29 19:30", ""),
    ("RES-229507", "Maria C Ibarra", "KIB-688", "Ford Escape Hybrid", "2026-05-23", "2026-05-29 20:00", ""),
    ("RES-344835", "Carlos Bermudez Diaz", "KQN757", "Nissan Kicks", "2026-05-23", "2026-05-30 14:00", ""),
    ("RES-272952", "Alberto Ramos", "KKQ820", "Nissan Pathfinder", "2026-05-21", "2026-05-30 15:30", ""),
    ("TL-ZE40785540BA", "Samuel Rojas", "JEO195", "Land Rover Range Rover", "2026-05-26", "2026-05-30 16:00", ""),
    ("RES-069810", "Michelle Correia", "KIR988", "Hyundai Palisade", "2026-05-24", "2026-05-30 16:30", ""),
    ("RES-783356", "Rafael Gonzalez", "KJF-928", "Toyota Highlander", "2026-05-22", "2026-05-30 16:30", "** plate conflict"),
    ("RES-020192", "MOHAMMED HUSSEIN", "KST893", "Mitsubishi Mirage", "2026-05-25", "2026-05-30 18:16", "** plate conflict"),
    ("RES-678926", "Brian Padilla", "KFW-858", "Ford Transit Connect", "2026-05-23", "2026-05-30 19:00", "** plate conflict"),
    ("RES-742838", "ERICK BOU", "KEE-032", "Hyundai Palisade", "2026-05-22", "2026-05-30 19:30", ""),
    ("RES-012328", "YUNUS LALLO", "KST788", "Mitsubishi Mirage", "2026-05-26", "2026-05-30 19:50", ""),
    ("RES-161699", "chris mireles", "KKZ-680", "Toyota Sienna", "2026-05-27", "2026-06-01 07:00", ""),
    ("RES-042412", "ANGEL MARRERO", "KHC525", "Nissan Versa", "2026-05-26", "2026-06-01 19:00", ""),
    ("RES-302086", "Leonaldo Nieves Ortiz", "KGU-553", "Hyundai Sonata", "2026-05-19", "2026-06-01 19:00", ""),
    ("RES-053826", "Arturo Granados", "KMV358", "Jeep Wrangler", "2026-05-19", "2026-06-01 19:30", ""),
    ("RES-145394", "WILLIAM ESTRELLA", "KDY-966", "Hyundai Venue", "2026-04-30", "2026-06-01 20:43", "EXTENDED +16d"),
    ("RES-624156", "Brian Yates", "KLK-739", "Toyota Corolla Cross", "2026-05-27", "2026-06-02 00:35", ""),
    ("RES-707200", "Shiarref Venson", "KNB777", "Toyota Corolla Cross", "2026-05-27", "2026-06-02 00:35", ""),
    ("RES-789369", "HUGO ORELLANA", "KJH-493", "Hyundai Palisade", "2026-05-24", "2026-06-02 14:42", ""),
    ("TL-ZE40784085BA", "Jacqueline Cruzado Rosario", "KST894", "Mitsubishi Mirage", "2026-05-26", "2026-06-02 20:15", ""),
    ("RES-952179", "Carmen Virella", "KST792", "Mitsubishi Mirage", "2026-05-24", "2026-06-03 14:00", ""),
    ("TL-ZE40785385BA", "Leonardo Morales", "KST793", "Mitsubishi Mirage", "2026-05-27", "2026-06-03 14:00", ""),
    ("RES-961024", "KEVIN CASTRO", "KST795", "Mitsubishi Mirage", "2026-05-26", "2026-06-03 17:32", ""),
    ("TL-ZE40785020BA", "Jose Mercado", "KLK-738", "Toyota Corolla Cross", "2026-05-27", "2026-06-03 18:30", ""),
    ("RES-656389", "Jose Antonio Santiago", "KHD-248", "Hyundai Venue", "2026-05-21", "2026-06-03 21:30", ""),
    ("RES-705541", "Margaret Matos", "KQN-820", "Nissan Kicks", "2026-05-20", "2026-06-05 17:00", ""),
    ("RES-814411", "EDUARDO CARDENAS", "KST790", "Mitsubishi Mirage", "2026-05-14", "2026-06-06 14:19", ""),
    ("RES-113914", "Candida Ortiz", "KKJ-005", "Nissan Kicks", "2026-05-25", "2026-06-06 21:00", ""),
    ("RES-542001", "ramon albino", "KQN763", "Nissan Kicks", "2026-05-04", "2026-06-06 23:15", ""),
    ("RES-613298", "OSCAR OCASIO", "KJF-927", "Toyota Corolla", "2026-05-07", "2026-06-06 23:30", ""),
    ("RES-264352", "ROBERTO MERCED", "KST794", "Mitsubishi Mirage", "2026-05-12", "2026-06-12 07:47", ""),
    ("WEB-181494280C6E", "Marian Valentin", "KHJ520", "Nissan Versa", "2026-05-24", "2026-06-24 19:40", "long-term"),
    ("WEB-176585770E9F", "marielys salas", "KHJ518", "Nissan Versa", "2026-05-23", "2026-08-10 23:10", "long-term"),
    ("RES-077038", "roberto jimenez", "KJF-928", "Toyota Highlander", "2027-04-16", "2027-05-16 09:27", "**BAD: 2027 dates"),
]

BUCKET_B = [
    # (reservation, customer, plate, vehicle, planned_return, days_overdue)
    ("RES-380081", "Elizabeth Soria", "KQN764", "Nissan Kicks", "2026-05-26 20:40", 1),
    ("RES-988644", "HUGO ALBERTO SPONTON", "KST896", "Mitsubishi Mirage", "2026-05-26 15:19", 1),
    ("RES-830429", "VIRGINIA SOLANO", "KHW-843", "Hyundai Palisade", "2026-05-25 19:00", 2),
    ("RES-246122", "CARMEN COLON", "KGO991", "Hyundai Venue", "2026-05-25 17:17", 2),
    ("RES-449555", "Crystal Diaz", "KST893", "Mitsubishi Mirage", "2026-05-25 17:00", 2),
    ("RES-854420", "MARANGENID ORTIZ", "1183910", "Ford F-150", "2026-05-25 13:05", 2),
    ("RES-964411", "Roberto Castro Robles", "KQN773", "Nissan Kicks", "2026-05-25 00:00", 3),
    ("RES-426653", "SHION MICHAEL", "KFW-860", "Ford Transit Connect", "2026-05-24 22:08", 3),
    ("RES-508521", "VENTURA VIVONI", "1183910", "Ford F-150", "2026-05-24 21:00", 3),
    ("RES-850921", "MARIA ESTELA ROSA", "(none)", "(no vehicle assigned)", "2026-05-24 17:30", 3),
    ("RES-743568", "Robert D Ortiz Lopez", "KFZ-616", "Chrysler Pacifica", "2026-05-24 17:00", 3),
    ("RES-992377", "Jenefer Baca", "KLK-739", "Toyota Corolla Cross", "2026-05-23 17:52", 4),
    ("RES-326714", "Emely Sanchez", "KJF-926", "Toyota Corolla", "2026-05-23 16:00", 4),
    ("RES-127201", "CARLOS ELVIRA", "KST896", "Mitsubishi Mirage", "2026-05-23 02:01", 4),
    ("RES-626840", "karla albors", "KJH-487", "Hyundai Elantra", "2026-05-23 00:26", 5),
    ("RES-171509", "ubaldo madera", "KST791", "Mitsubishi Mirage", "2026-05-22 22:00", 5),
    ("RES-176052", "Kara Hooser", "KST789", "Mitsubishi Mirage", "2026-05-22 14:00", 5),
    ("RES-731925", "Yadiel Cruz", "KHW-843", "Hyundai Palisade", "2026-05-22 12:15", 5),
    ("RES-904623", "Nicholas Geever", "KFW-858", "Ford Transit Connect", "2026-05-21 19:00", 6),
    ("RES-756971", "JOHAN PEREZ", "KGU-552", "Hyundai Tucson", "2026-05-21 14:20", 6),
    ("RES-759253", "Carlos Cid", "KFW-860", "Ford Transit Connect", "2026-05-21 10:30", 6),
    ("RES-293548", "Julian Rios", "KHC511", "Nissan Versa", "2026-05-20 19:00", 7),
    ("RES-739240", "RADAMES CALVO", "KNB777", "Toyota Corolla Cross", "2026-05-20 16:15", 7),
    ("RES-455229", "Luis Alicea", "KST893", "Mitsubishi Mirage", "2026-05-19 17:00", 8),
    ("RES-083011", "KALKIDAN BEKELE ARGAW", "KST894", "Mitsubishi Mirage", "2026-05-19 15:44", 8),
    ("RES-896241", "Devin Martinez-Orengo", "KST896", "Mitsubishi Mirage", "2026-05-19 14:30", 8),
    ("RES-318298", "KELLY MENA", "KJU-495", "Jeep Wrangler", "2026-05-18 21:00", 9),
    ("RES-557786", "Jackelyn Santiago", "KII873", "Mitsubishi Mirage", "2026-05-18 19:30", 9),
    ("RES-907569", "Francisco Del Rey", "KKJ-004", "Nissan Kicks", "2026-05-18 14:30", 9),
    ("RES-805066", "JORDACHE MILTON", "KBS537", "Chevrolet Express", "2026-05-18 03:00", 9),
    ("RES-311931", "JAMIE ZAVALA", "KLK-738", "Toyota Corolla Cross", "2026-05-17 21:43", 10),
    ("RES-166320", "Eddy Luis Cabreja Rivas", "JQT-988", "Kia Carnival", "2026-05-17 20:15", 10),
    ("RES-435570", "DEVAN FREEMAN", "KST795", "Mitsubishi Mirage", "2026-05-17 18:46", 10),
    ("RES-588235", "LESLIANNY FEBRES", "H98797", "Ford E450", "2026-05-16 22:02", 11),
    ("RES-670178", "NATHNEAL MULUGETA", "KHJ520", "Nissan Versa", "2026-05-16 15:07", 11),
    ("RES-275572", "Edwin Otero", "KFW-858", "Ford Transit Connect", "2026-05-16 14:30", 11),
    ("RES-173709", "JASMINE BURGESS", "KLK-106", "Toyota Corolla Cross", "2026-05-15 12:55", 12),
    ("RES-192991", "NIKI LOPEZ", "KOI-313", "Chevrolet Blazer", "2026-05-14 16:00", 13),
    ("RES-675234", "NGAI JONES", "KMR719", "Dodge Durango", "2026-05-14 14:48", 13),
]

VEHICLE_CONFLICTS = [
    # (plate, vehicle, reservations)
    ("KST896", "Mitsubishi Mirage", [
        ("RES-988644", "Hugo Sponton", "bucket B - 1d overdue"),
        ("RES-127201", "Carlos Elvira", "bucket B - 4d overdue"),
        ("RES-896241", "Devin Martinez", "bucket B - 8d overdue"),
    ]),
    ("KFW-858", "Ford Transit Connect", [
        ("RES-678926", "Brian Padilla", "bucket A - active"),
        ("RES-904623", "Nicholas Geever", "bucket B - 6d overdue"),
        ("RES-275572", "Edwin Otero", "bucket B - 11d overdue"),
    ]),
    ("KST893", "Mitsubishi Mirage", [
        ("RES-020192", "Mohammed Hussein", "bucket A - active"),
        ("RES-449555", "Crystal Diaz", "bucket B - 2d overdue"),
        ("RES-455229", "Luis Alicea", "bucket B - 8d overdue"),
    ]),
    ("KFW-860", "Ford Transit Connect", [
        ("RES-426653", "Shion Michael", "bucket B - 3d overdue"),
        ("RES-759253", "Carlos Cid", "bucket B - 6d overdue"),
    ]),
    ("KMR719", "Dodge Durango", [
        ("RES-867597", "Fajr Ahmad", "bucket A - active"),
        ("RES-675234", "Ngai Jones", "bucket B - 13d overdue"),
    ]),
    ("KHW-843", "Hyundai Palisade", [
        ("RES-830429", "Virginia Solano", "bucket B - 2d overdue"),
        ("RES-731925", "Yadiel Cruz", "bucket B - 5d overdue"),
    ]),
    ("1183910", "Ford F-150", [
        ("RES-854420", "Marangenid Ortiz", "bucket B - 2d overdue"),
        ("RES-508521", "Ventura Vivoni", "bucket B - 3d overdue"),
    ]),
    ("KHC511", "Nissan Versa", [
        ("RES-538241", "Rebecca Mercado", "bucket A - active"),
        ("RES-293548", "Julian Rios", "bucket B - 7d overdue"),
    ]),
    ("KJF-928", "Toyota Highlander", [
        ("RES-783356", "Rafael Gonzalez", "bucket A - active"),
        ("RES-077038", "Roberto Jimenez", "bucket A - BAD DATA (2027 dates)"),
    ]),
]

# ---------------------------------------------------------------------------
# Document builders
# ---------------------------------------------------------------------------

def make_table(data, col_widths, header_bg='#1F2937', body_bg=None, font_size=8):
    """Common Table builder with consistent styling."""
    style = [
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor(header_bg)),
        ('TEXTCOLOR',  (0, 0), (-1, 0), colors.white),
        ('FONTNAME',   (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE',   (0, 0), (-1, -1), font_size),
        ('VALIGN',     (0, 0), (-1, -1), 'TOP'),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1),
         [colors.white, colors.HexColor('#F9FAFB')]),
        ('GRID',       (0, 0), (-1, -1), 0.25, colors.HexColor('#D1D5DB')),
        ('LEFTPADDING',  (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING',   (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING',(0, 0), (-1, -1), 4),
    ]
    return Table(data, colWidths=col_widths, style=TableStyle(style),
                 repeatRows=1)


def add_page_number(canvas, doc):
    canvas.saveState()
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(colors.HexColor('#9CA3AF'))
    canvas.drawString(0.5 * inch, 0.4 * inch,
                      f"Inventory Reconciliation · 2026-05-27")
    canvas.drawRightString(8.0 * inch, 0.4 * inch,
                           f"Page {doc.page}")
    canvas.restoreState()


# ---------------------------------------------------------------------------
# Build the story
# ---------------------------------------------------------------------------
story = []

# Cover
story.append(Spacer(1, 1.2 * inch))
story.append(Paragraph("Inventory Reconciliation", title_style))
story.append(Paragraph(
    "International Rental Corp · San Juan Airport &nbsp;|&nbsp; "
    "Generated 2026-05-27", subtitle_style))

story.append(Paragraph("The situation", h2))
story.append(Paragraph(
    "System reports 46 currently active reservations against your physical "
    "count of 49 contracts in store. Beyond that gap, the database is holding "
    "39 reservations that are 1-14 days past their planned return and 60 "
    "more that are 14+ days stale (likely returned but never closed in the "
    "system). Several vehicles appear assigned to two or three reservations "
    "at once, and one row is marked CHECKED_OUT in the year 2027.",
    body))
story.append(Paragraph(
    "This document is the working plan for the lot walk-through tomorrow. "
    "Each section is meant to be checked off as you go.", body))

story.append(Spacer(1, 0.2 * inch))
story.append(Paragraph("Current state snapshot", h2))
snapshot = [
    ["Bucket", "Definition", "Reservations", "Unique vehicles"],
    ["A. Active (within window)", "CHECKED_OUT, returnAt > now", "46", "45"],
    ["B. Recently overdue (1-14d)", "CHECKED_OUT, returnAt 1-14d past", "39", "31"],
    ["C. Stale (>14d overdue)", "CHECKED_OUT, returnAt 14d+ past", "60", "49"],
    ["", "Total reservations system thinks are out", "145", ""],
    ["", "Your physical store count", "49", ""],
    ["", "Reconciliation target", "─ 96 phantoms ─", ""],
]
story.append(make_table(snapshot, [1.7*inch, 2.7*inch, 1.4*inch, 1.4*inch],
                        font_size=9))
story.append(Spacer(1, 0.15 * inch))
story.append(Paragraph(
    "<b>Of the 46 active reservations only 1 is recorded as extended in the "
    "system</b> (William Estrella, RES-145394, +16 days). The other ~3 contracts "
    "you have in hand are almost certainly customers you extended verbally "
    "but never recorded — they're sitting in Bucket B right now and will "
    "snap back into Bucket A as soon as you extend them in the wizard.",
    body))

story.append(PageBreak())

# ---------------------------------------------------------------------------
# Section 1: Critical anomalies
# ---------------------------------------------------------------------------
story.append(Paragraph("Critical anomalies — fix first", h1))

story.append(Paragraph("1. Reservation in the year 2027", h2))
story.append(Paragraph(
    "<b>RES-077038</b> — roberto jimenez, KJF-928 Toyota Highlander. "
    "Pickup date is recorded as 2027-04-16, return 2027-05-16, but the "
    "reservation is marked CHECKED_OUT. Either a year typo on creation or "
    "a parser edge case. Either way, this row is currently propping up "
    "the active count by 1 with bogus data and is also double-booking "
    "KJF-928 with RES-783356 (Rafael Gonzalez, the real current rental).",
    body))
story.append(Paragraph(
    "<b>Action:</b> Either correct the dates if you find paperwork showing "
    "the intended year (2026), or flip the reservation to CHECKED_IN / "
    "CANCELLED if the customer already returned / never picked up.",
    body))

story.append(Paragraph("2. Reservation with no vehicle assigned", h2))
story.append(Paragraph(
    "<b>RES-850921</b> — Maria Estela Rosa, vehicle field is NULL, planned "
    "return was 2026-05-24 (3 days ago). Marked CHECKED_OUT but the system "
    "has no idea which car she has. Will need a manual check against your "
    "paper contract to figure out the vehicle and assign it back — or, if "
    "Maria never picked up, mark as NO_SHOW.", body))

story.append(Paragraph("3. Vehicle double-bookings (9 plates)", h2))
story.append(Paragraph(
    "Same plate appears on multiple active or recently-overdue reservations. "
    "A car can't be in two places, so for each plate exactly one reservation "
    "is the live rental and the others are stale. Resolving these 9 plates "
    "alone removes 9 phantoms from the count and frees vehicles that the "
    "system currently thinks are stuck out.", body))

conflict_table_data = [["Plate", "Vehicle", "Reservation", "Customer", "Status"]]
for plate, vehicle, rows in VEHICLE_CONFLICTS:
    for i, (res, cust, status) in enumerate(rows):
        conflict_table_data.append([
            plate if i == 0 else "",
            vehicle if i == 0 else "",
            res, cust, status
        ])
story.append(make_table(conflict_table_data,
                        [0.9*inch, 1.5*inch, 1.4*inch, 1.7*inch, 1.7*inch],
                        font_size=8))
story.append(Spacer(1, 0.1 * inch))
story.append(Paragraph(
    "<b>Heuristic:</b> the older/longer-overdue row on each plate is usually "
    "the stale one — the vehicle came back but was never closed in the "
    "system. Mark those CHECKED_IN if paid in full or CHECKED_IN_UNPAID if "
    "money is still owed.", body))

story.append(PageBreak())

# ---------------------------------------------------------------------------
# Section 2: The 4-pass workflow
# ---------------------------------------------------------------------------
story.append(Paragraph("Recommended workflow", h1))
story.append(Paragraph(
    "Four passes through the data, narrowest to broadest. Each pass leaves "
    "fewer rows for the next.", body))

story.append(Paragraph("Pass 1 — Resolve the 9 vehicle conflicts", h2))
story.append(Paragraph(
    "For each plate in the conflict table, identify which reservation is "
    "the real current rental and which are stale. The Active-bucket row is "
    "almost always the live one. Close the others via "
    "/reservations?filter=overdue using Mark returned or Full checkin. "
    "Estimated time: ~15 minutes, removes ~12-15 phantoms.", body))

story.append(Paragraph("Pass 2 — Find the verbal extensions (3 of 39)", h2))
story.append(Paragraph(
    "Walk Bucket B against your 49 paper contracts. Three customers should "
    "still be in your hand — those are the ones you verbally extended. "
    "Extend them in the system via the reservation page; the wizard now "
    "correctly updates both reservation.returnAt and agreement.returnAt "
    "(today's fix). They'll automatically move from Bucket B to Bucket A "
    "and bring your active count to 49.", body))

story.append(Paragraph("Pass 3 — RES-850921 (no vehicle)", h2))
story.append(Paragraph(
    "Manual check — assign the correct vehicle from paperwork, then mark "
    "appropriate status. Or NO_SHOW if Maria never picked up.", body))

story.append(Paragraph("Pass 4 — Close out the rest of Bucket B + Bucket C", h2))
story.append(Paragraph(
    "Remaining ~33 in Bucket B plus 60 in Bucket C are the bulk cleanup. "
    "Vehicles returned long ago, never closed. Per-row triage via the UI: "
    "Mark returned (CHECKED_IN_UNPAID if balance pending, CHECKED_IN if "
    "paid) or NO_SHOW for the few NEW/CONFIRMED rows. Pace it across a "
    "few sessions — the per-row buttons make this quick.", body))

story.append(Paragraph(
    "<b>End state:</b> 49 active reservations matching your 49 paper "
    "contracts. Available vehicles count aligns with what's physically in "
    "the lot. From this baseline, future overdues get triaged within "
    "their natural cycle and stale data never accumulates again.", callout))

story.append(PageBreak())

# ---------------------------------------------------------------------------
# Section 3: Bucket A (46 active)
# ---------------------------------------------------------------------------
story.append(Paragraph("Bucket A — 46 active reservations", h1))
story.append(Paragraph(
    "All CHECKED_OUT with returnAt &gt; now. Sorted by due-back ascending. "
    "Flag column highlights known issues (plate conflict / bad data / "
    "extension recorded / long-term).", body))

bA = [["Reservation", "Customer", "Plate", "Vehicle", "Picked up", "Due back", "Flag"]]
for row in BUCKET_A:
    bA.append(list(row))
story.append(make_table(bA,
                        [1.0*inch, 1.4*inch, 0.7*inch, 1.5*inch,
                         0.8*inch, 1.1*inch, 1.0*inch],
                        font_size=7))

story.append(PageBreak())

# ---------------------------------------------------------------------------
# Section 4: Bucket B (39 recently overdue)
# ---------------------------------------------------------------------------
story.append(Paragraph("Bucket B — 39 recently overdue", h1))
story.append(Paragraph(
    "CHECKED_OUT, returnAt 1-14 days past. Sorted by overdue-recency. "
    "The 3 verbal extensions you're holding are somewhere in this list.",
    body))

bB = [["Reservation", "Customer", "Plate", "Vehicle", "Planned return", "Days late"]]
for row in BUCKET_B:
    bB.append([row[0], row[1], row[2], row[3], row[4], str(row[5])])
story.append(make_table(bB,
                        [1.0*inch, 1.5*inch, 0.7*inch, 1.5*inch,
                         1.2*inch, 0.6*inch],
                        font_size=7))

story.append(PageBreak())

# ---------------------------------------------------------------------------
# Section 5: SQL reference
# ---------------------------------------------------------------------------
story.append(Paragraph("SQL appendix — handy queries", h1))
story.append(Paragraph(
    "If you need to re-run the diagnostics during the walk-through, paste "
    "these into Supabase. Tenant id is inlined for International Rental Corp.",
    body))

story.append(Paragraph("Active reservations (Bucket A — should land at 49 after cleanup)", h2))
story.append(Paragraph(
    "SELECT r.\"reservationNumber\", c.\"firstName\" || ' ' || c.\"lastName\" AS customer,<br/>"
    "&nbsp;&nbsp;v.plate, r.\"pickupAt\"::date AS picked_up, r.\"returnAt\" AS due_back<br/>"
    "FROM   \"Reservation\" r<br/>"
    "LEFT JOIN \"Customer\" c ON c.id = r.\"customerId\"<br/>"
    "LEFT JOIN \"Vehicle\"  v ON v.id = r.\"vehicleId\"<br/>"
    "WHERE  r.\"tenantId\" = 'cmn98hc1u0085ke0i4vefujt3'<br/>"
    "&nbsp;&nbsp;AND  r.status = 'CHECKED_OUT'<br/>"
    "&nbsp;&nbsp;AND  r.\"returnAt\" &gt; NOW()<br/>"
    "ORDER BY r.\"returnAt\" ASC;",
    mono))

story.append(Paragraph("Recently overdue (Bucket B)", h2))
story.append(Paragraph(
    "SELECT r.\"reservationNumber\", c.\"firstName\" || ' ' || c.\"lastName\" AS customer,<br/>"
    "&nbsp;&nbsp;v.plate, r.\"returnAt\" AS planned_return,<br/>"
    "&nbsp;&nbsp;EXTRACT(DAY FROM (NOW() - r.\"returnAt\"))::int AS days_overdue<br/>"
    "FROM   \"Reservation\" r<br/>"
    "LEFT JOIN \"Customer\" c ON c.id = r.\"customerId\"<br/>"
    "LEFT JOIN \"Vehicle\"  v ON v.id = r.\"vehicleId\"<br/>"
    "WHERE  r.\"tenantId\" = 'cmn98hc1u0085ke0i4vefujt3'<br/>"
    "&nbsp;&nbsp;AND  r.status = 'CHECKED_OUT'<br/>"
    "&nbsp;&nbsp;AND  r.\"returnAt\" &lt;= NOW()<br/>"
    "&nbsp;&nbsp;AND  r.\"returnAt\" &gt; NOW() - INTERVAL '14 days'<br/>"
    "ORDER BY r.\"returnAt\" DESC;",
    mono))

story.append(Paragraph("Stale (Bucket C — bulk close-out target)", h2))
story.append(Paragraph(
    "SELECT r.\"reservationNumber\", c.\"firstName\" || ' ' || c.\"lastName\" AS customer,<br/>"
    "&nbsp;&nbsp;v.plate, r.\"returnAt\" AS planned_return,<br/>"
    "&nbsp;&nbsp;EXTRACT(DAY FROM (NOW() - r.\"returnAt\"))::int AS days_overdue<br/>"
    "FROM   \"Reservation\" r<br/>"
    "LEFT JOIN \"Customer\" c ON c.id = r.\"customerId\"<br/>"
    "LEFT JOIN \"Vehicle\"  v ON v.id = r.\"vehicleId\"<br/>"
    "WHERE  r.\"tenantId\" = 'cmn98hc1u0085ke0i4vefujt3'<br/>"
    "&nbsp;&nbsp;AND  r.status = 'CHECKED_OUT'<br/>"
    "&nbsp;&nbsp;AND  r.\"returnAt\" &lt;= NOW() - INTERVAL '14 days'<br/>"
    "ORDER BY r.\"returnAt\" ASC;",
    mono))

story.append(Paragraph("Sanity check after the walk-through", h2))
story.append(Paragraph(
    "Run this at the end of the session — should ideally show "
    "active=49, recently_overdue=0, stale=0:",
    body))
story.append(Paragraph(
    "SELECT<br/>"
    "&nbsp;&nbsp;COUNT(*) FILTER (WHERE r.\"returnAt\" &gt; NOW()) AS active,<br/>"
    "&nbsp;&nbsp;COUNT(*) FILTER (WHERE r.\"returnAt\" &lt;= NOW()<br/>"
    "&nbsp;&nbsp;&nbsp;&nbsp;AND r.\"returnAt\" &gt; NOW() - INTERVAL '14 days') AS recently_overdue,<br/>"
    "&nbsp;&nbsp;COUNT(*) FILTER (WHERE r.\"returnAt\" &lt;= NOW() - INTERVAL '14 days') AS stale<br/>"
    "FROM   \"Reservation\" r<br/>"
    "WHERE  r.\"tenantId\" = 'cmn98hc1u0085ke0i4vefujt3'<br/>"
    "&nbsp;&nbsp;AND  r.status = 'CHECKED_OUT';",
    mono))

# ---------------------------------------------------------------------------
# Build PDF
# ---------------------------------------------------------------------------
doc = SimpleDocTemplate(
    OUT_PATH, pagesize=letter,
    leftMargin=0.5*inch, rightMargin=0.5*inch,
    topMargin=0.6*inch, bottomMargin=0.6*inch,
    title="Inventory Reconciliation — International Rental Corp",
    author="Ride Fleet Manager",
)
doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)
print(f"Wrote {OUT_PATH}")
