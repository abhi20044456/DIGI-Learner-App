# Digi Learner

A responsive course-learning web app built with Flask, PostgreSQL, HTML, CSS, and JavaScript. It includes student and admin dashboards, manual UPI payment review, course progress, completion approvals, quizzes, and verifiable PDF certificates.

## Features

### For learners

- Create an account with three distinct password-recovery questions. Answers are normalized and stored as one-way password hashes.
- Sign in with password input that supports show/hide and canonical Unicode normalization, or change/reset a password from account security settings.
- Browse courses, search the catalog, enroll in free courses, and submit paid-course UPI reference details.
- Follow enrolled course topics in **Course topics** and view teacher-provided videos and resource URLs in **Sources and videos**. Clicking a topic title opens a YouTube search in a new tab.
- Mark topics complete and see course and overall learning progress.
- Request course-completion review after every topic is complete. The final quiz becomes available after an admin approves the request.
- Take the course quiz. Learners only see answer choices, not the answer key. A passing score of at least 90% triggers a celebration and on-screen certificate; download the branded certificate as PDF or PNG. The PDF includes a unique ID and QR link to its public verification page.
- Track courses, completed topics, pending reviews, certificates, and payment requests on the learner dashboard.

### For admins

- Review users, courses, enrollments, pending payments, pending completion requests, quiz passes, issued certificates, and recent approved revenue on the dashboard.
- Add, update, publish, and archive courses; organize course topics and their video/resource links.
- Approve course completion requests one at a time or in bulk. Approved learners can then take that course's final quiz.
- Configure a quiz for each course, add and edit multiple-choice questions, choose correct answers, and publish it. The passing threshold cannot be set below 90%.
- Review UPI references before granting paid-course access. Duplicate references are flagged, and rejected payments can include a reason.
- Import `.xlsx` course/topic data with a live upload percentage, row-level results, and a downloadable template; export course data as CSV.
- Configure UPI details, QR image URL, and payment instructions.

## Run locally on Windows

1. Extract the ZIP and open the `digi_learner_app` folder in VS Code.
2. Copy `.env.example` to `.env` in that folder.
3. Add your PostgreSQL/Neon connection string, a long random `SECRET_KEY`, and a strong initial admin email and password. Keep `.env` private; it is not included in the ZIP.
4. In **Terminal → New Terminal**, install dependencies:

   ```powershell
   py -m pip install -r requirements.txt
   ```

5. Start the app:

   ```powershell
   py app.py
   ```

6. Open `http://127.0.0.1:5000`. Sign in with the initial admin account, configure payment details, add and publish courses, and create a quiz for each course.

The admin account is created on first startup only when `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set. Changing these environment variables later does not change an existing admin account's password.

### Existing users and existing databases

The app adds the new completion/session columns and creates the recovery, quiz, attempt, and certificate tables when it starts. Back up a database before upgrading an app that already contains real data. Students with an existing account should sign in and open **Account security** to save three recovery questions before a password reset is needed. Updating the app invalidates sessions if the account password was reset or changed; sign in again if asked.

The database connection pool reduces repeated connection setup. An expired CSRF/session token is refreshed once and the payment/import request is retried; if the actual sign-in session has expired, the learner must sign in again.

## Set up course quizzes and certificates

1. In Admin, open **Quizzes & certificates**, choose a course, and set its quiz title and passing score (90–100%).
2. Add questions and answer choices, mark the correct choice, then publish the quiz.
3. Learners mark each topic complete and submit a completion request.
4. Review the request in **Course approvals**. Approve one learner or select several and approve them in bulk.
5. Once approved, the learner takes the final quiz. Passing creates one certificate for that learner and course. The PDF's QR code opens the public verification page.

## Deploy on Render with Neon

1. Put the extracted app files in a GitHub repository and connect that repository to a Render Web Service.
2. Use the included `render.yaml`, or set the build command to `pip install -r requirements.txt` and the start command to `gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --timeout 120`.
3. Set `DATABASE_URL`, `ADMIN_EMAIL`, and a strong `ADMIN_PASSWORD` in Render. The included blueprint generates `SECRET_KEY`; keep `COOKIE_SECURE=true` on HTTPS hosting.
4. Deploy and open the Render URL. The database tables and initial admin account are prepared on startup.

If a database password or connection string has ever been shared in a chat or public location, rotate it in Neon and use the new value in Render. This ZIP contains no database credentials.

The Render blueprint uses the free web-service plan. Render notes that free web services spin down after 15 minutes without inbound traffic, so the first visit after idle time may take longer. Review [Render's free plan limits](https://render.com/docs/free) before using it for a production course business.

## Excel import format

The downloadable template uses these columns in this order:

```text
CourseCode, CourseTitle, CourseDescription, ImageURL, CourseVideoURL, Paid, Price, Published, TopicTitle, TopicDescription, VideoURL, ResourceURL, SortOrder
```

Use one row per topic. Repeat the course fields on each row for that course. `Paid` and `Published` accept `TRUE/FALSE`, `Yes/No`, or `1/0`. A row with an empty `TopicTitle` creates or updates the course without adding a topic. Course codes and topic titles are matched without case sensitivity for updates. The progress bar shows the workbook upload percentage; after upload, the app reports row processing results.

## Payment notes

The app does not receive automatic UPI payment confirmation. Learners pay in their own UPI app, then submit the UTR/reference number and payment date. Admins should verify the amount and reference in bank/UPI records before approving; a screenshot or button click is not proof that funds arrived.

## Operational notes

- Video, resource, course image, and QR fields store external URLs; the app does not host uploaded media.
- Back up the Neon database before using real student or payment data.
- Admin operations are checked on the Flask backend. Do not grant admin access by editing client-side HTML.
- Password recovery questions are a convenience, not as strong as email-based recovery with verified ownership. Encourage learners to use hard-to-guess answers and keep their login secure.
