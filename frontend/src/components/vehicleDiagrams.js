/**
 * Vehicle inspection diagrams (2026-06-11). Approved art direction (Hector):
 * premium line-art in the app violet. One family per vehicle type, four base
 * views each (side/front/rear/interior); RIGHT is the mirrored side view.
 * All inner-SVG fragments target viewBox "0 0 400 210".
 *
 * Consumed by the customer inspection page (/inspect/[token]) and later by
 * the agent review queue + Vehicle Profile damage history (Fases B/C) so all
 * three render damage dots on identical canvases.
 */

export const DIAGRAM_VIEWBOX = '0 0 400 210';
export const DIAGRAM_W = 400;
export const DIAGRAM_H = 210;

const SUV = {
  side: `
  <path d="M 64,192 L 348,192" fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round"/>
  <g fill="#CECBF6" fill-opacity="0.45" stroke="#AFA9EC" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
    <path d="M 279,89 C 270,73 262,64 249,59 L 201,57 L 198,89 Z"/>
    <path d="M 188,57 L 190,89 L 104,89 C 105,72 112,62 127,58 Z"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 56,168 L 82,168 A 36 36 0 0 1 154,168 L 272,168 A 36 36 0 0 1 344,168 L 354,168 C 361,167 365,161 365,152 L 365,134 C 365,118 361,106 351,99 C 332,92 312,90 290,89 C 277,68 267,58 251,52 C 213,46 160,46 122,50 C 107,53 97,64 92,84 C 84,96 76,106 71,120 C 67,134 66,148 69,158 C 67,163 62,167 56,168 Z"/>
    <circle cx="118" cy="162" r="26"/>
    <circle cx="308" cy="162" r="26"/>
    <path d="M 291,82 C 287,80 286,75 290,72 C 295,69 303,70 305,74 C 307,79 303,83 297,83 C 295,83 292,83 291,82 Z"/>
    <path d="M 345,101 C 353,100 360,104 364,110"/>
    <path d="M 90,92 C 82,93 75,97 70,103"/>
    <path d="M 226,100 L 250,100" stroke-width="2"/>
    <path d="M 158,100 L 180,100" stroke-width="2"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 126,45 C 165,41 210,41 247,46"/>
    <path d="M 134,44 L 134,48"/>
    <path d="M 240,45 L 240,48"/>
    <path d="M 286,87 C 274,68 266,59 252,54"/>
    <path d="M 283,93 C 282,110 281,124 280,138"/>
    <path d="M 195,93 C 194,118 193,142 193,165"/>
    <path d="M 148,93 C 147,106 146,116 142,124 C 138,130 131,133 124,133"/>
    <path d="M 164,159 L 264,159"/>
    <path d="M 347,107 C 353,106 358,109 361,114"/>
    <path d="M 88,98 C 83,99 79,102 76,106"/>
    <path d="M 289,88 L 291,83"/>
    <circle cx="118" cy="162" r="10.5"/>
    <circle cx="308" cy="162" r="10.5"/>
    <path d="M 118,151 L 118,140 M 128.5,158.6 L 138.9,155.2 M 124.5,170.9 L 130.9,179.8 M 111.5,170.9 L 105.1,179.8 M 107.5,158.6 L 97.1,155.2" stroke-width="1.2"/>
    <path d="M 308,151 L 308,140 M 318.5,158.6 L 328.9,155.2 M 314.5,170.9 L 320.9,179.8 M 301.5,170.9 L 295.1,179.8 M 297.5,158.6 L 287.1,155.2" stroke-width="1.2"/>
  </g>
  <circle cx="118" cy="162" r="3" fill="#534AB7" stroke="none"/>
  <circle cx="308" cy="162" r="3" fill="#534AB7" stroke="none"/>`,
  front: `
  <path d="M 86,193 L 314,193" fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M 140,56 C 162,52 238,52 260,56 C 264,66 266,76 267,86 C 224,81 176,81 133,86 C 134,76 136,66 140,56 Z" fill="#CECBF6" fill-opacity="0.45" stroke="#AFA9EC" stroke-width="1.4" stroke-linejoin="round"/>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 134,46 C 156,42 244,42 266,46 C 280,50 287,62 290,82 C 295,104 297,128 297,146 C 297,160 293,168 284,170 L 116,170 C 107,168 103,160 103,146 C 103,128 105,104 110,82 C 113,62 120,50 134,46 Z"/>
    <path d="M 108,85 C 98,83 90,86 90,93 C 90,99 98,102 107,99 Z"/>
    <path d="M 292,85 C 302,83 310,86 310,93 C 310,99 302,102 293,99 Z"/>
    <rect x="120" y="103" width="40" height="8" rx="4"/>
    <rect x="240" y="103" width="40" height="8" rx="4"/>
    <path d="M 116,170 L 116,180 C 116,184 119,186 123,186 L 139,186 C 143,186 146,184 146,180 L 146,170"/>
    <path d="M 254,170 L 254,180 C 254,184 257,186 261,186 L 277,186 C 281,186 284,184 284,180 L 284,170"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 137,44 L 135,37"/>
    <path d="M 263,44 L 265,37"/>
    <path d="M 130,94 C 170,90 230,90 270,94"/>
    <path d="M 168,104 L 232,104"/>
    <path d="M 170,109 L 230,109"/>
    <path d="M 172,114 L 228,114"/>
    <rect x="150" y="134" width="100" height="17" rx="8.5" stroke-width="1.6"/>
    <path d="M 166,159 L 234,159"/>
  </g>
  <g fill="none" stroke="#534AB7" stroke-width="1.6" stroke-linecap="round">
    <path d="M 126,107 L 150,107"/>
    <path d="M 250,107 L 274,107"/>
  </g>`,
  rear: `
  <path d="M 86,193 L 314,193" fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M 138,55 C 162,51 238,51 262,55 C 266,65 268,75 269,84 C 224,80 176,80 131,84 C 132,75 134,65 138,55 Z" fill="#CECBF6" fill-opacity="0.45" stroke="#AFA9EC" stroke-width="1.4" stroke-linejoin="round"/>
  <rect x="112" y="100" width="48" height="10" rx="5" fill="#F4C0D1" fill-opacity="0.7" stroke="#7F77DD" stroke-width="2.2"/>
  <rect x="240" y="100" width="48" height="10" rx="5" fill="#F4C0D1" fill-opacity="0.7" stroke="#7F77DD" stroke-width="2.2"/>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 134,46 C 156,42 244,42 266,46 C 280,50 287,62 290,82 C 295,104 297,128 297,146 C 297,160 293,168 284,170 L 116,170 C 107,168 103,160 103,146 C 103,128 105,104 110,82 C 113,62 120,50 134,46 Z"/>
    <path d="M 106,86 C 98,84 92,87 92,93 C 92,98 99,100 106,98"/>
    <path d="M 294,86 C 302,84 308,87 308,93 C 308,98 301,100 294,98"/>
    <path d="M 116,170 L 116,180 C 116,184 119,186 123,186 L 139,186 C 143,186 146,184 146,180 L 146,170"/>
    <path d="M 254,170 L 254,180 C 254,184 257,186 261,186 L 277,186 C 281,186 284,184 284,180 L 284,170"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 132,43 C 165,38 235,38 268,43"/>
    <path d="M 164,105 L 236,105" stroke-width="1.2"/>
    <rect x="173" y="120" width="54" height="26" rx="4" stroke-width="1.6"/>
    <path d="M 131,90 C 129,108 128,124 129,142" stroke-width="1.2"/>
    <path d="M 269,90 C 271,108 272,124 271,142" stroke-width="1.2"/>
    <path d="M 110,152 L 290,152"/>
  </g>
  <g fill="none" stroke="#534AB7" stroke-width="1.6" stroke-linejoin="round">
    <rect x="138" y="158" width="22" height="7" rx="3.5"/>
    <rect x="240" y="158" width="22" height="7" rx="3.5"/>
  </g>`,
  interior: `
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 112,38 L 298,38 C 330,38 350,52 351,84 L 351,126 C 350,158 330,172 298,172 L 112,172 C 82,172 60,162 54,132 C 51,118 51,92 54,78 C 60,48 82,38 112,38 Z"/>
    <circle cx="133" cy="76" r="19"/>
    <rect x="170" y="50" width="56" height="40" rx="12"/>
    <rect x="170" y="120" width="56" height="40" rx="12"/>
    <rect x="256" y="48" width="50" height="114" rx="14"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 98,42 C 112,70 112,140 98,168" stroke-width="1.6"/>
    <path d="M 127.5,76 L 115,76 M 138.5,76 L 151,76 M 133,81.5 L 133,94"/>
    <rect x="152" y="95" width="80" height="20" rx="9" stroke-width="1.6"/>
    <circle cx="196" cy="105" r="4.5" stroke-width="1.2"/>
    <circle cx="212" cy="105" r="4.5" stroke-width="1.2"/>
    <path d="M 214,54 C 217,65 217,75 214,86"/>
    <path d="M 177,56 C 174,67 174,73 177,84" stroke-width="1.2"/>
    <path d="M 214,124 C 217,135 217,145 214,156"/>
    <path d="M 177,126 C 174,137 174,143 177,154" stroke-width="1.2"/>
    <path d="M 260,86 L 302,86"/>
    <path d="M 260,124 L 302,124"/>
    <path d="M 292,52 C 296,80 296,130 292,158" stroke-width="1.2"/>
    <path d="M 322,44 C 327,72 327,138 322,166" stroke-width="1.2"/>
    <path d="M 132,44 L 192,44" stroke-width="1.6"/>
    <path d="M 238,44 L 296,44" stroke-width="1.6"/>
    <path d="M 132,166 L 192,166" stroke-width="1.6"/>
    <path d="M 238,166 L 296,166" stroke-width="1.6"/>
  </g>
  <circle cx="133" cy="76" r="5.5" fill="#534AB7" stroke="none"/>
  <circle cx="170" cy="105" r="4" fill="none" stroke="#534AB7" stroke-width="1.6"/>`,
};

const SEDAN = {
  side: `
  <path d="M40 186 L360 186" fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round"/>
  <g fill="#CECBF6" fill-opacity="0.45" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">
    <path d="M128 110 C138 101 150 94 164 91 L174 90 L174 110 Z"/>
    <path d="M182 110 L182 89 L210 88 C230 88 246 97 254 110 Z"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M120 115 C170 112 240 113 264 116"/>
    <path d="M198 114 C197 126 196 138 196 150"/>
    <path d="M150 146 L256 146"/>
    <path d="M264 106 C266 100 273 100 274 105 C275 109 270 112 266 110"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round">
    <circle cx="115" cy="162" r="10"/>
    <circle cx="285" cy="162" r="10"/>
    <path d="M115 162 L115 152 M115 162 L105.5 158.9 M115 162 L109.1 170.1 M115 162 L120.9 170.1 M115 162 L124.5 158.9"/>
    <path d="M285 162 L285 152 M285 162 L275.5 158.9 M285 162 L279.1 170.1 M285 162 L290.9 170.1 M285 162 L294.5 158.9"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M56 152 L88 152 A29 29 0 0 1 142 152 L258 152 A29 29 0 0 1 312 152 L344 152 C352 148 354 140 350 132 C344 122 322 118 298 116 C282 114 272 113 266 112 C252 94 234 84 212 82 C188 80 166 84 150 92 C136 99 124 106 106 110 C84 114 60 116 52 126 C46 134 48 146 56 152 Z"/>
    <circle cx="115" cy="162" r="23"/>
    <circle cx="285" cy="162" r="23"/>
  </g>
  <g fill="none" stroke="#534AB7" stroke-width="1.8" stroke-linecap="round">
    <path d="M320 118 C330 119 338 122 344 127"/>
    <path d="M170 120 L158 120"/>
    <path d="M218 120 L206 120"/>
  </g>
  <path d="M50 127 C50 124 52 122 55 122 L62 123 L62 133 L55 133 C52 133 50 131 50 130 Z" fill="#F4C0D1" fill-opacity="0.7" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round"/>
  <circle cx="115" cy="162" r="2.5" fill="#534AB7"/>
  <circle cx="285" cy="162" r="2.5" fill="#534AB7"/>`,
  front: `
  <path d="M100 186 L300 186" fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M160 106 C166 95 176 92 200 92 C224 92 234 95 240 106 L240 108 C214 104 186 104 160 108 Z" fill="#CECBF6" fill-opacity="0.45" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round"/>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M178 134 L222 134"/>
    <path d="M184 140 L216 140"/>
    <path d="M134 154 C160 150 240 150 266 154"/>
    <path d="M168 162 L232 162"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M126 176 C122 176 120 172 120 166 L120 138 C120 124 126 114 138 108 L150 102 C156 92 168 88 200 88 C232 88 244 92 250 102 L262 108 C274 114 280 124 280 138 L280 166 C280 172 278 176 274 176 Z"/>
    <path d="M120 112 C112 110 107 114 108 120 C109 125 115 126 120 122"/>
    <path d="M280 112 C288 110 293 114 292 120 C291 125 285 126 280 122"/>
    <path d="M132 176 L132 182 C132 185 134 186 137 186 L147 186 C150 186 152 185 152 182 L152 176"/>
    <path d="M248 176 L248 182 C248 185 250 186 253 186 L263 186 C266 186 268 185 268 182 L268 176"/>
  </g>
  <g fill="none" stroke="#534AB7" stroke-width="1.8" stroke-linecap="round">
    <path d="M132 126 C142 122 154 122 162 125"/>
    <path d="M268 126 C258 122 246 122 238 125"/>
  </g>`,
  rear: `
  <path d="M100 186 L300 186" fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M162 106 C168 95 178 92 200 92 C222 92 232 95 238 106 L238 108 C212 104 188 104 162 108 Z" fill="#CECBF6" fill-opacity="0.45" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round"/>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M150 142 L250 142"/>
    <path d="M184 146 C182 146 181 147 181 149 L181 161 C181 163 182 164 184 164 L216 164 C218 164 219 163 219 161 L219 149 C219 147 218 146 216 146 Z"/>
    <path d="M130 170 L270 170"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M126 176 C122 176 120 172 120 166 L120 138 C120 124 126 114 138 108 L150 102 C156 92 168 88 200 88 C232 88 244 92 250 102 L262 108 C274 114 280 124 280 138 L280 166 C280 172 278 176 274 176 Z"/>
    <path d="M120 112 C112 110 107 114 108 120 C109 125 115 126 120 122"/>
    <path d="M280 112 C288 110 293 114 292 120 C291 125 285 126 280 122"/>
    <path d="M132 176 L132 182 C132 185 134 186 137 186 L147 186 C150 186 152 185 152 182 L152 176"/>
    <path d="M248 176 L248 182 C248 185 250 186 253 186 L263 186 C266 186 268 185 268 182 L268 176"/>
  </g>
  <g fill="#F4C0D1" fill-opacity="0.7" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round">
    <path d="M134 122 L166 122 C170 122 172 124 172 128 C172 132 170 134 166 134 L134 134 C130 134 128 132 128 128 C128 124 130 122 134 122 Z"/>
    <path d="M234 122 L266 122 C270 122 272 124 272 128 C272 132 270 134 266 134 L234 134 C230 134 228 132 228 128 C228 124 230 122 234 122 Z"/>
  </g>`,
  interior: `
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M128 62 C162 50 238 50 272 62"/>
    <path d="M192 64 C192 62 194 60 197 60 L203 60 C206 60 208 62 208 64 L208 116 C208 119 206 121 203 121 L197 121 C194 121 192 119 192 116 Z"/>
    <path d="M146 98 L180 98"/>
    <path d="M220 98 L254 98"/>
    <path d="M140 146 L260 146"/>
    <path d="M177 146 L177 170"/>
    <path d="M223 146 L223 170"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round">
    <path d="M163 78 L148 78 M163 78 L178 78 M163 78 L163 93"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M148 30 L252 30 C268 30 278 38 280 52 L282 158 C282 172 272 180 258 180 L142 180 C128 180 118 172 118 158 L120 52 C122 38 132 30 148 30 Z"/>
    <circle cx="163" cy="78" r="15"/>
    <path d="M142 96 C142 92 145 90 150 90 L176 90 C181 90 184 92 184 96 L184 126 C184 130 181 132 176 132 L150 132 C145 132 142 130 142 126 Z"/>
    <path d="M216 96 C216 92 219 90 224 90 L250 90 C255 90 258 92 258 96 L258 126 C258 130 255 132 250 132 L224 132 C219 132 216 130 216 126 Z"/>
    <path d="M136 144 C136 140 139 138 144 138 L256 138 C261 138 264 140 264 144 L264 166 C264 170 261 172 256 172 L144 172 C139 172 136 170 136 166 Z"/>
  </g>
  <circle cx="163" cy="78" r="3" fill="#534AB7"/>`,
};

const VAN = {
  side: `
  <path d="M40 186 L360 186" fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round"/>
  <g fill="#CECBF6" fill-opacity="0.45" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">
    <path d="M76 98 L78 64 C78 60 81 58 85 58 L128 58 L128 98 Z"/>
    <path d="M138 98 L138 62 C138 59 140 58 143 58 L207 58 C210 58 212 59 212 62 L212 98 Z"/>
    <path d="M220 98 L220 60 L262 58 C274 62 286 70 296 82 C299 87 297 92 290 94 L220 98 Z"/>
    <path d="M310 82 C318 90 324 98 330 106 L322 108 C316 99 309 91 303 86 Z"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M216 100 L214 144"/>
    <path d="M134 100 L133 144"/>
    <path d="M70 112 L126 112 C131 112 134 109 135 104"/>
    <path d="M150 138 L256 138"/>
    <path d="M296 72 C299 65 307 65 308 71 C309 76 303 79 298 77"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round">
    <circle cx="112" cy="160" r="10"/>
    <circle cx="288" cy="160" r="10"/>
    <path d="M112 160 L112 150 M112 160 L102.5 156.9 M112 160 L106.1 168.1 M112 160 L117.9 168.1 M112 160 L121.5 156.9"/>
    <path d="M288 160 L288 150 M288 160 L278.5 156.9 M288 160 L282.1 168.1 M288 160 L293.9 168.1 M288 160 L297.5 156.9"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M54 148 L83 148 A32 32 0 0 1 141 148 L259 148 A32 32 0 0 1 317 148 L342 148 C352 146 356 138 354 128 C352 114 346 104 336 96 C328 90 316 84 306 76 C298 62 284 52 264 50 C216 47 168 47 122 48 C100 49 82 52 73 58 C63 64 58 74 58 88 L55 136 C54 142 53 146 54 148 Z"/>
    <circle cx="112" cy="160" r="25"/>
    <circle cx="288" cy="160" r="25"/>
  </g>
  <g fill="none" stroke="#534AB7" stroke-width="1.8" stroke-linecap="round">
    <path d="M336 102 C344 106 349 112 352 118"/>
    <path d="M228 108 L242 108"/>
    <path d="M198 108 L212 108"/>
  </g>
  <path d="M61 92 L66 92 C68 92 69 93 69 95 L69 114 C69 116 68 117 66 117 L61 117 C59 117 58 116 58 114 L58 95 C58 93 59 92 61 92 Z" fill="#F4C0D1" fill-opacity="0.7" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round"/>
  <circle cx="112" cy="160" r="2.5" fill="#534AB7"/>
  <circle cx="288" cy="160" r="2.5" fill="#534AB7"/>`,
  front: `
  <path d="M100 186 L300 186" fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M134 98 L134 76 C134 66 140 60 152 58 C184 54 216 54 248 58 C260 60 266 66 266 76 L266 98 C222 93 178 93 134 98 Z" fill="#CECBF6" fill-opacity="0.45" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round"/>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M176 118 L224 118"/>
    <path d="M182 126 L218 126"/>
    <path d="M126 152 C160 148 240 148 274 152"/>
    <path d="M170 162 L230 162"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M126 180 C121 180 118 176 118 170 L118 86 C118 70 124 59 137 55 C158 49 242 49 263 55 C276 59 282 70 282 86 L282 170 C282 176 279 180 274 180 Z"/>
    <path d="M118 84 C109 82 104 86 105 93 C106 99 113 100 118 96"/>
    <path d="M282 84 C291 82 296 86 295 93 C294 99 287 100 282 96"/>
    <path d="M132 180 L132 183 C132 185 134 186 137 186 L147 186 C150 186 152 185 152 183 L152 180"/>
    <path d="M248 180 L248 183 C248 185 250 186 253 186 L263 186 C266 186 268 185 268 183 L268 180"/>
  </g>
  <g fill="none" stroke="#534AB7" stroke-width="1.8" stroke-linecap="round">
    <path d="M128 108 C138 104 150 104 158 107"/>
    <path d="M272 108 C262 104 250 104 242 107"/>
  </g>`,
  rear: `
  <path d="M100 186 L300 186" fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M138 98 L138 72 C138 64 144 60 152 59 L248 59 C256 60 262 64 262 72 L262 98 C220 94 180 94 138 98 Z" fill="#CECBF6" fill-opacity="0.45" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round"/>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M122 150 L278 150"/>
    <path d="M182 156 C180 156 179 157 179 159 L179 169 C179 171 180 172 182 172 L218 172 C220 172 221 171 221 169 L221 159 C221 157 220 156 218 156 Z"/>
    <path d="M128 176 L272 176"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M126 180 C121 180 118 176 118 170 L118 86 C118 70 124 59 137 55 C158 49 242 49 263 55 C276 59 282 70 282 86 L282 170 C282 176 279 180 274 180 Z"/>
    <path d="M118 84 C109 82 104 86 105 93 C106 99 113 100 118 96"/>
    <path d="M282 84 C291 82 296 86 295 93 C294 99 287 100 282 96"/>
    <path d="M132 180 L132 183 C132 185 134 186 137 186 L147 186 C150 186 152 185 152 183 L152 180"/>
    <path d="M248 180 L248 183 C248 185 250 186 253 186 L263 186 C266 186 268 185 268 183 L268 180"/>
  </g>
  <g fill="#F4C0D1" fill-opacity="0.7" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round">
    <path d="M126 105 L138 105 C140 105 141 106 141 108 L141 142 C141 144 140 145 138 145 L126 145 C124 145 123 144 123 142 L123 108 C123 106 124 105 126 105 Z"/>
    <path d="M262 105 L274 105 C276 105 277 106 277 108 L277 142 C277 144 276 145 274 145 L262 145 C260 145 259 144 259 142 L259 108 C259 106 260 105 262 105 Z"/>
  </g>`,
  interior: `
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M126 54 C160 40 240 40 274 54"/>
    <path d="M192 56 C192 54 194 52 197 52 L203 52 C206 52 208 54 208 56 L208 100 C208 103 206 105 203 105 L197 105 C194 105 192 103 192 100 Z"/>
    <path d="M146 90 L178 90"/>
    <path d="M222 90 L254 90"/>
    <path d="M146 134 L178 134"/>
    <path d="M222 134 L254 134"/>
    <path d="M140 170 L260 170"/>
    <path d="M176 170 L176 180"/>
    <path d="M224 170 L224 180"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round">
    <path d="M162 70 L147 70 M162 70 L177 70 M162 70 L162 85"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M148 22 L252 22 C270 22 280 30 282 44 L284 168 C284 180 274 188 260 188 L140 188 C126 188 116 180 116 168 L118 44 C120 30 130 22 148 22 Z"/>
    <circle cx="162" cy="70" r="15"/>
    <path d="M142 88 C142 84 145 82 150 82 L174 82 C179 82 182 84 182 88 L182 112 C182 116 179 118 174 118 L150 118 C145 118 142 116 142 112 Z"/>
    <path d="M218 88 C218 84 221 82 226 82 L250 82 C255 82 258 84 258 88 L258 112 C258 116 255 118 250 118 L226 118 C221 118 218 116 218 112 Z"/>
    <path d="M142 132 C142 128 145 126 150 126 L174 126 C179 126 182 128 182 132 L182 152 C182 156 179 158 174 158 L150 158 C145 158 142 156 142 152 Z"/>
    <path d="M218 132 C218 128 221 126 226 126 L250 126 C255 126 258 128 258 132 L258 152 C258 156 255 158 250 158 L226 158 C221 158 218 156 218 152 Z"/>
    <path d="M136 168 C136 164 139 162 144 162 L256 162 C261 162 264 164 264 168 L264 176 C264 180 261 182 256 182 L144 182 C139 182 136 180 136 176 Z"/>
  </g>
  <circle cx="162" cy="70" r="3" fill="#534AB7"/>`,
};

const PICKUP = {
  side: `
  <path d="M40 186 L360 186" fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round"/>
  <g fill="#CECBF6" fill-opacity="0.45" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">
    <path d="M166 96 L168 78 C168 74 171 72 176 72 L186 72 L186 96 Z"/>
    <path d="M194 96 L194 74 C194 73 195 72 196 72 L228 72 C238 72 246 78 252 88 C254 92 252 95 247 96 Z"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M58 110 L57 137"/>
    <path d="M156 110 L156 138"/>
    <path d="M62 113 L148 113"/>
    <path d="M192 98 L190 138"/>
    <path d="M170 134 L250 134"/>
    <path d="M258 74 C261 67 269 67 270 73 C271 78 265 81 260 79"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round">
    <circle cx="108" cy="157" r="10"/>
    <circle cx="292" cy="157" r="10"/>
    <path d="M108 157 L108 147 M108 157 L98.5 153.9 M108 157 L102.1 165.1 M108 157 L113.9 165.1 M108 157 L117.5 153.9"/>
    <path d="M292 157 L292 147 M292 157 L282.5 153.9 M292 157 L286.1 165.1 M292 157 L297.9 165.1 M292 157 L301.5 153.9"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M52 140 L79 140 A34 34 0 0 1 137 140 L263 140 A34 34 0 0 1 321 140 L346 140 C353 137 356 129 354 121 C352 113 344 108 330 106 C312 102 292 100 276 98 C269 93 264 85 258 78 C252 70 244 66 232 66 L200 66 C186 66 176 68 168 74 C162 79 160 90 158 106 L150 108 L54 108 C51 108 49 110 48 113 L46 126 C44 132 47 138 52 140 Z"/>
    <circle cx="108" cy="157" r="27"/>
    <circle cx="292" cy="157" r="27"/>
  </g>
  <g fill="none" stroke="#534AB7" stroke-width="1.8" stroke-linecap="round">
    <path d="M334 109 C342 111 348 114 351 119"/>
    <path d="M206 104 L220 104"/>
  </g>
  <path d="M52 112 L56 112 L56 124 L52 124 C50 124 49 123 49 121 L49 115 C49 113 50 112 52 112 Z" fill="#F4C0D1" fill-opacity="0.7" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round"/>
  <circle cx="108" cy="157" r="2.5" fill="#534AB7"/>
  <circle cx="292" cy="157" r="2.5" fill="#534AB7"/>`,
  front: `
  <path d="M96 186 L304 186" fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M156 94 C159 80 168 76 200 76 C232 76 241 80 244 94 L244 97 C214 92 186 92 156 97 Z" fill="#CECBF6" fill-opacity="0.45" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round"/>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M152 114 C148 114 146 116 146 119 L146 143 C146 146 148 148 152 148 L248 148 C252 148 254 146 254 143 L254 119 C254 116 252 114 248 114 Z"/>
    <path d="M154 125 L246 125"/>
    <path d="M154 136 L246 136"/>
    <path d="M124 158 L276 158"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M120 162 L120 116 C120 106 124 100 134 98 L146 96 C150 80 160 72 200 72 C240 72 250 80 254 96 L266 98 C276 100 280 106 280 116 L280 162 C280 167 277 170 272 170 L128 170 C123 170 120 167 120 162 Z"/>
    <path d="M120 90 C111 88 106 92 107 98 C108 104 115 105 120 101"/>
    <path d="M280 90 C289 88 294 92 293 98 C292 104 285 105 280 101"/>
    <path d="M130 170 L130 182 C130 185 132 186 135 186 L153 186 C156 186 158 185 158 182 L158 170"/>
    <path d="M242 170 L242 182 C242 185 244 186 247 186 L265 186 C268 186 270 185 270 182 L270 170"/>
  </g>
  <g fill="none" stroke="#534AB7" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M130 114 L140 114 C141 114 142 115 142 117 L142 127 C142 129 141 130 140 130 L130 130 C129 130 128 129 128 127 L128 117 C128 115 129 114 130 114 Z"/>
    <path d="M260 114 L270 114 C271 114 272 115 272 117 L272 127 C272 129 271 130 270 130 L260 130 C259 130 258 129 258 127 L258 117 C258 115 259 114 260 114 Z"/>
  </g>`,
  rear: `
  <path d="M96 186 L304 186" fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M170 94 L170 84 C170 78 175 75 183 75 L217 75 C225 75 230 78 230 84 L230 94 C210 91 190 91 170 94 Z" fill="#CECBF6" fill-opacity="0.45" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round"/>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M142 108 L258 108"/>
    <path d="M142 152 L258 152"/>
    <path d="M183 116 L217 116 C221 116 223 118 223 121 C223 124 221 126 217 126 L183 126 C179 126 177 124 177 121 C177 118 179 116 183 116 Z"/>
    <path d="M186 132 L214 132 C217 132 218 133 218 136 L218 146 C218 149 217 150 214 150 L186 150 C183 150 182 149 182 146 L182 136 C182 133 183 132 186 132 Z"/>
    <path d="M124 158 L276 158"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M122 162 L122 110 C122 105 125 102 130 102 L270 102 C275 102 278 105 278 110 L278 162 C278 167 275 170 270 170 L130 170 C125 170 122 167 122 162 Z"/>
    <path d="M160 102 L160 84 C160 73 169 67 182 66 L218 66 C231 67 240 73 240 84 L240 102"/>
    <path d="M160 84 C152 82 147 85 148 91 C149 96 155 97 160 94"/>
    <path d="M240 84 C248 82 253 85 252 91 C251 96 245 97 240 94"/>
    <path d="M132 170 L132 182 C132 185 134 186 137 186 L155 186 C158 186 160 185 160 182 L160 170"/>
    <path d="M240 170 L240 182 C240 185 242 186 245 186 L263 186 C266 186 268 185 268 182 L268 170"/>
  </g>
  <g fill="#F4C0D1" fill-opacity="0.7" stroke="#AFA9EC" stroke-width="1.2" stroke-linejoin="round">
    <path d="M128 110 L138 110 C140 110 141 111 141 113 L141 143 C141 145 140 146 138 146 L128 146 C126 146 125 145 125 143 L125 113 C125 111 126 110 128 110 Z"/>
    <path d="M262 110 L272 110 C274 110 275 111 275 113 L275 143 C275 145 274 146 272 146 L262 146 C260 146 259 145 259 143 L259 113 C259 111 260 110 262 110 Z"/>
  </g>`,
  interior: `
  <g fill="none" stroke="#AFA9EC" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M130 70 C162 58 238 58 270 70"/>
    <path d="M142 110 L258 110"/>
    <path d="M212 102 L212 138"/>
    <path d="M154 154 L246 154"/>
  </g>
  <g fill="none" stroke="#AFA9EC" stroke-width="1.2" stroke-linecap="round">
    <path d="M164 86 L149 86 M164 86 L179 86 M164 86 L164 101"/>
  </g>
  <g fill="none" stroke="#7F77DD" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M150 40 L250 40 C266 40 276 48 278 62 L280 156 C280 168 270 176 256 176 L144 176 C130 176 120 168 120 156 L122 62 C124 48 134 40 150 40 Z"/>
    <circle cx="164" cy="86" r="15"/>
    <path d="M138 108 C138 104 141 102 146 102 L254 102 C259 102 262 104 262 108 L262 132 C262 136 259 138 254 138 L146 138 C141 138 138 136 138 132 Z"/>
    <path d="M150 152 C150 148 153 146 158 146 L242 146 C247 146 250 148 250 152 L250 164 C250 168 247 170 242 170 L158 170 C153 170 150 168 150 164 Z"/>
  </g>
  <circle cx="164" cy="86" r="3" fill="#534AB7"/>`,
};

const FAMILIES = { suv: SUV, sedan: SEDAN, van: VAN, pickup: PICKUP };

export const VIEW_LABELS = Object.freeze({
  LEFT: 'Left', RIGHT: 'Right', FRONT: 'Front', REAR: 'Rear', INTERIOR: 'Interior',
});

/**
 * Inner-SVG markup for (diagramType, view). RIGHT mirrors the side art.
 * Unknown types fall back to sedan.
 */
export function diagramFor(diagramType, view) {
  const family = FAMILIES[String(diagramType || '').toLowerCase()] || FAMILIES.sedan;
  const v = String(view || '').toUpperCase();
  if (v === 'LEFT') return family.side;
  if (v === 'RIGHT') return `<g transform="scale(-1,1) translate(-${DIAGRAM_W},0)">${family.side}</g>`;
  if (v === 'FRONT') return family.front;
  if (v === 'REAR') return family.rear;
  if (v === 'INTERIOR') return family.interior;
  return family.side;
}
