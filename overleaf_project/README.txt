QuietSpace System Architecture & Engineering Report
Senior Design Project - North Carolina A&T State University (NCAT)
Department of Computer Science
Target Deployment: F.D. Bluford Library (Rooms 311, 312, 313)

============================================================
HOW TO OPEN IN OVERLEAF:
============================================================
1. Open your browser and go to https://www.overleaf.com
2. Log in or create an account.
3. Click "New Project" in the top-left corner.
4. Select "Upload Project".
5. Upload this .zip file ("quietspace_system_report_overleaf.zip").
6. Overleaf will extract the project and automatically compile "main.tex" into a professional PDF!

============================================================
FIGURE AND DIAGRAM PLACEMENT FIXES:
============================================================
- Strict in-place positioning is enforced via the LaTeX "float" package using the [H] placement specifier, ensuring all architecture diagrams, sequence flows, ER schemas, QR placards, and data tables render directly beneath their respective section headings and introductory text.
- Large portrait graphics (such as the system architecture flow) are proportionally constrained using "keepaspectratio" with bounded height ("height=0.52\textheight") to prevent LaTeX float queue overflow.
- Clean page breaks (\clearpage) ensure optimal visual separation between major sections.
- Verified and synchronized with the latest codebase: 10 test suites, 137 passing tests under Jest/Supertest, bcrypt staff authentication, and per-room decibel sensitivity thresholds.
