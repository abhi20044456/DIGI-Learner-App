import csv
import hmac
import io
import json
import os
import secrets
import csv
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import date
from decimal import Decimal, InvalidOperation
from functools import wraps

import psycopg
from dotenv import load_dotenv
from flask import Flask, g, jsonify, make_response, render_template, request, send_file, session, url_for
from openpyxl import Workbook, load_workbook
from psycopg.errors import UniqueViolation
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool, PoolTimeout
from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.exceptions import HTTPException

load_dotenv()

app = Flask(__name__)
secret_key = os.getenv("SECRET_KEY", "").strip() or secrets.token_hex(32)
app.config.update(
    SECRET_KEY=secret_key,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("COOKIE_SECURE", "false").lower() == "true",
    MAX_CONTENT_LENGTH=5 * 1024 * 1024,
)

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
DATABASE_POOL = None
if DATABASE_URL:
    DATABASE_POOL = ConnectionPool(
        conninfo=DATABASE_URL,
        min_size=1,
        max_size=int(os.getenv("DB_POOL_MAX_SIZE", "5")),
        timeout=5,
        kwargs={"row_factory": dict_row, "connect_timeout": 5},
        open=False,
    )
DEFAULT_SETTINGS = {
    "upi_id": os.getenv("ADMIN_UPI", ""),
    "qr_image_url": os.getenv("ADMIN_QR_IMAGE_URL", ""),
    "payment_instructions": "Scan the QR code, pay the exact course amount, then submit your UTR/reference number here.",
}

RECOVERY_QUESTIONS = {
    "first_school": "What was the name of your first school?",
    "first_teacher": "What was the first name of a favorite teacher?",
    "childhood_friend": "What was the first name of a childhood friend?",
    "first_pet": "What was the name of your first pet?",
    "childhood_street": "What was the name of the street where you grew up?",
    "first_job": "What was your first job or role?",
    "favorite_book": "What was a favorite childhood book?",
    "family_city": "In which city did a close family member grow up?",
}


class ApiError(Exception):
    def __init__(self, message, status=400):
        self.message = message
        self.status = status


@contextmanager
def database_connection():
    if not DATABASE_POOL:
        raise ApiError("Database is not configured. Add DATABASE_URL to your .env file.", 503)
    try:
        with DATABASE_POOL.connection(timeout=5) as conn:
            yield conn
    except (ApiError, UniqueViolation):
        raise
    except (psycopg.Error, PoolTimeout) as exc:
        app.logger.exception("Could not connect to PostgreSQL")
        raise ApiError("Database connection failed. Check DATABASE_URL and try again.", 503) from exc


def create_schema():
    if not DATABASE_URL:
        return
    statements = [
        """CREATE TABLE IF NOT EXISTS users (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
            active BOOLEAN NOT NULL DEFAULT TRUE,
            session_version INTEGER NOT NULL DEFAULT 0,
            last_login TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )""",
        """CREATE TABLE IF NOT EXISTS courses (
            id BIGSERIAL PRIMARY KEY,
            code TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            image_url TEXT NOT NULL DEFAULT '',
            course_video_url TEXT NOT NULL DEFAULT '',
            is_paid BOOLEAN NOT NULL DEFAULT FALSE,
            price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
            published BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )""",
        """CREATE TABLE IF NOT EXISTS topics (
            id BIGSERIAL PRIMARY KEY,
            course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            video_url TEXT NOT NULL DEFAULT '',
            resource_url TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )""",
        """CREATE TABLE IF NOT EXISTS enrollments (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
            completion_status TEXT NOT NULL DEFAULT 'in_progress' CHECK (completion_status IN ('in_progress', 'pending', 'approved', 'rejected')),
            completion_submitted_at TIMESTAMPTZ,
            completion_reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
            completion_reviewed_at TIMESTAMPTZ,
            completion_review_note TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, course_id)
        )""",
        """CREATE TABLE IF NOT EXISTS topic_progress (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            topic_id BIGINT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
            completed BOOLEAN NOT NULL DEFAULT TRUE,
            completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, topic_id)
        )""",
        """CREATE TABLE IF NOT EXISTS payment_requests (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
            utr TEXT NOT NULL,
            payment_date DATE,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
            admin_note TEXT NOT NULL DEFAULT '',
            reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reviewed_at TIMESTAMPTZ
        )""",
        """CREATE TABLE IF NOT EXISTS app_settings (
            setting_key TEXT PRIMARY KEY,
            setting_value TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )""",
        """CREATE TABLE IF NOT EXISTS recovery_questions (
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            question_key TEXT NOT NULL,
            answer_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY(user_id, question_key)
        )""",
        """CREATE TABLE IF NOT EXISTS password_reset_attempts (
            email TEXT PRIMARY KEY,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            locked_until TIMESTAMPTZ
        )""",
        """CREATE TABLE IF NOT EXISTS quizzes (
            id BIGSERIAL PRIMARY KEY,
            course_id BIGINT NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE,
            title TEXT NOT NULL DEFAULT 'Course completion quiz',
            published BOOLEAN NOT NULL DEFAULT FALSE,
            pass_percentage NUMERIC(5,2) NOT NULL DEFAULT 90 CHECK (pass_percentage >= 90 AND pass_percentage <= 100),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )""",
        """CREATE TABLE IF NOT EXISTS quiz_questions (
            id BIGSERIAL PRIMARY KEY,
            quiz_id BIGINT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
            prompt TEXT NOT NULL,
            options JSONB NOT NULL,
            correct_option INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )""",
        """CREATE TABLE IF NOT EXISTS quiz_attempts (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            score NUMERIC(5,2) NOT NULL,
            correct_count INTEGER NOT NULL,
            question_count INTEGER NOT NULL,
            passed BOOLEAN NOT NULL,
            answers JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )""",
        """CREATE TABLE IF NOT EXISTS certificates (
            certificate_code UUID PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            quiz_attempt_id BIGINT NOT NULL UNIQUE REFERENCES quiz_attempts(id) ON DELETE RESTRICT,
            issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, course_id)
        )""",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS completion_status TEXT NOT NULL DEFAULT 'in_progress'",
        "ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS completion_submitted_at TIMESTAMPTZ",
        "ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS completion_reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL",
        "ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS completion_reviewed_at TIMESTAMPTZ",
        "ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS completion_review_note TEXT NOT NULL DEFAULT ''",
        "CREATE INDEX IF NOT EXISTS idx_courses_published ON courses(published)",
        "CREATE INDEX IF NOT EXISTS idx_topics_course_order ON topics(course_id, sort_order, id)",
        "CREATE INDEX IF NOT EXISTS idx_payments_status ON payment_requests(status, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_payments_user ON payment_requests(user_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_progress_user ON topic_progress(user_id, topic_id)",
        "CREATE INDEX IF NOT EXISTS idx_enrollment_completion ON enrollments(completion_status, completion_submitted_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz_order ON quiz_questions(quiz_id, sort_order, id)",
        "CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_course ON quiz_attempts(user_id, course_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_certificates_user ON certificates(user_id, issued_at DESC)",
    ]
    with database_connection() as conn:
        for statement in statements:
            conn.execute(statement)
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT INTO app_settings (setting_key, setting_value) VALUES (%s, %s) ON CONFLICT (setting_key) DO NOTHING",
                (key, value),
            )
        admin_email = os.getenv("ADMIN_EMAIL", "").strip().lower()
        admin_password = os.getenv("ADMIN_PASSWORD", "")
        admin_name = os.getenv("ADMIN_NAME", "Application Admin").strip() or "Application Admin"
        if admin_email and admin_password:
            conn.execute(
                """INSERT INTO users (name, email, password_hash, role)
                   VALUES (%s, %s, %s, 'admin') ON CONFLICT (email) DO NOTHING""",
                (admin_name, admin_email, generate_password_hash(admin_password)),
            )


def read_json():
    return request.get_json(silent=True) or {}


def current_user():
    if getattr(g, "current_user_loaded", False):
        return g.current_user
    user_id = session.get("user_id")
    if not user_id:
        g.current_user_loaded = True
        g.current_user = None
        return None
    with database_connection() as conn:
        user = conn.execute(
            "SELECT id, name, email, role, active, created_at, session_version FROM users WHERE id = %s",
            (user_id,),
        ).fetchone()
    if not user or not user["active"]:
        session.clear()
        g.current_user_loaded = True
        g.current_user = None
        return None
    version = int(user["session_version"] or 0)
    if session.get("session_version") is not None and int(session["session_version"]) != version:
        session.clear()
        g.current_user_loaded = True
        g.current_user = None
        return None
    session["session_version"] = version
    user = dict(user)
    user.pop("session_version", None)
    g.current_user_loaded = True
    g.current_user = user
    return user


def require_login(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user or not user["active"]:
            session.clear()
            raise ApiError("Please sign in to continue.", 401)
        request.user = user
        return fn(*args, **kwargs)
    return wrapped


def require_admin(fn):
    @wraps(fn)
    @require_login
    def wrapped(*args, **kwargs):
        if request.user["role"] != "admin":
            raise ApiError("Admin access is required.", 403)
        return fn(*args, **kwargs)
    return wrapped


def validate_csrf():
    if request.path.startswith("/api/") and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        expected = session.get("csrf_token", "")
        supplied = request.headers.get("X-CSRF-Token", "")
        if not expected or not supplied or not hmac.compare_digest(expected, supplied):
            raise ApiError("Your session expired. Refresh the page and try again.", 403)


@app.before_request
def protect_api_changes():
    validate_csrf()


@app.errorhandler(ApiError)
def handle_api_error(exc):
    return jsonify({"error": exc.message}), exc.status


@app.errorhandler(UniqueViolation)
def handle_duplicate(exc):
    return jsonify({"error": "This value already exists. Check the course code or UTR/reference number."}), 409


@app.errorhandler(413)
def handle_upload_too_large(_exc):
    return jsonify({"error": "File is too large. Upload an Excel file under 5 MB."}), 413


@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/session")
def api_session():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)
    user = current_user()
    if user:
        user["created_at"] = user["created_at"].isoformat() if user.get("created_at") else None
    return jsonify({"user": user, "csrf_token": session["csrf_token"]})


@app.post("/api/register")
def api_register():
    data = read_json()
    name = str(data.get("name", "")).strip()
    email = str(data.get("email", "")).strip().lower()
    password = normalize_password(data.get("password", ""))
    if len(name) < 2 or len(name) > 100:
        raise ApiError("Enter your name (2 to 100 characters).")
    if "@" not in email or len(email) > 254:
        raise ApiError("Enter a valid email address.")
    if len(password) < 8:
        raise ApiError("Choose a password with at least 8 characters.")
    recovery = parse_recovery_answers(data)
    with database_connection() as conn:
        user = conn.execute(
            """INSERT INTO users (name, email, password_hash) VALUES (%s, %s, %s)
               ON CONFLICT (email) DO NOTHING RETURNING id, name, email, role, active, created_at, session_version""",
            (name, email, generate_password_hash(password)),
        ).fetchone()
        if not user:
            raise ApiError("An account with this email already exists. Sign in instead.", 409)
        insert_recovery_answers(conn, user["id"], recovery)
    session.clear()
    session["user_id"] = user["id"]
    session["session_version"] = int(user["session_version"] or 0)
    session["csrf_token"] = secrets.token_urlsafe(32)
    user_data = {key: value for key, value in user.items() if key != "session_version"}
    user_data["created_at"] = user_data["created_at"].isoformat()
    return jsonify({"user": user_data}), 201


@app.post("/api/login")
def api_login():
    data = read_json()
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    with database_connection() as conn:
        user = conn.execute("SELECT * FROM users WHERE email = %s", (email,)).fetchone()
        if not user or not user["active"]:
            raise ApiError("Email or password does not match. Check the password and Caps Lock, or reset it.", 401)
        valid_password, canonical_password, should_rehash = verify_password(user["password_hash"], password)
        if not valid_password:
            raise ApiError("Email or password does not match. Check the password and Caps Lock, or reset it.", 401)
        if should_rehash:
            conn.execute("UPDATE users SET password_hash=%s WHERE id=%s", (generate_password_hash(canonical_password), user["id"]))
        conn.execute("UPDATE users SET last_login = NOW() WHERE id = %s", (user["id"],))
    session.clear()
    session["user_id"] = user["id"]
    session["session_version"] = int(user["session_version"] or 0)
    session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify({"user": {"id": user["id"], "name": user["name"], "email": user["email"], "role": user["role"]}})


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify({"ok": True})


def normalize_answer(value):
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).casefold().split())


def normalize_password(value):
    # Canonically equivalent Unicode input should not behave like two different passwords.
    # Whitespace is intentionally preserved; it can be part of a passphrase.
    return unicodedata.normalize("NFC", str(value or ""))


def verify_password(stored_hash, supplied):
    raw = str(supplied or "")
    canonical = normalize_password(raw)
    candidates = dict.fromkeys((canonical, raw, unicodedata.normalize("NFD", raw)))
    for candidate in candidates:
        if candidate and check_password_hash(stored_hash, candidate):
            return True, canonical, candidate != canonical
    return False, canonical, False


def parse_recovery_answers(data):
    answers = []
    for number in range(1, 4):
        key = str(data.get(f"recovery_{number}_key", "")).strip()
        answer = normalize_answer(data.get(f"recovery_{number}_answer", ""))
        if key not in RECOVERY_QUESTIONS:
            raise ApiError("Choose all three account recovery questions.")
        if len(answer) < 2 or len(answer) > 200:
            raise ApiError("Each recovery answer must be between 2 and 200 characters.")
        answers.append((key, answer))
    if len({key for key, _answer in answers}) != 3:
        raise ApiError("Choose three different recovery questions.")
    return answers


def insert_recovery_answers(conn, user_id, answers):
    for key, answer in answers:
        conn.execute(
            """INSERT INTO recovery_questions(user_id, question_key, answer_hash) VALUES(%s,%s,%s)
               ON CONFLICT(user_id, question_key) DO UPDATE SET answer_hash=EXCLUDED.answer_hash, created_at=NOW()""",
            (user_id, key, generate_password_hash(answer)),
        )


@app.get("/api/recovery-questions")
def api_recovery_question_catalog():
    return jsonify({"questions": [{"key": key, "label": label} for key, label in RECOVERY_QUESTIONS.items()]})


@app.get("/api/me/security")
@require_login
def api_security_status():
    with database_connection() as conn:
        count = conn.execute("SELECT COUNT(*)::int AS count FROM recovery_questions WHERE user_id=%s", (request.user["id"],)).fetchone()["count"]
    return jsonify({"recovery_question_count": count})


@app.put("/api/me/security/questions")
@require_login
def api_update_recovery_questions():
    answers = parse_recovery_answers(read_json())
    with database_connection() as conn:
        conn.execute("DELETE FROM recovery_questions WHERE user_id=%s", (request.user["id"],))
        insert_recovery_answers(conn, request.user["id"], answers)
    return jsonify({"ok": True})


@app.post("/api/me/change-password")
@require_login
def api_change_password():
    data = read_json()
    old_password = str(data.get("current_password", ""))
    new_password = normalize_password(data.get("new_password", ""))
    if len(new_password) < 8:
        raise ApiError("Choose a new password with at least 8 characters.")
    with database_connection() as conn:
        row = conn.execute("SELECT password_hash FROM users WHERE id=%s", (request.user["id"],)).fetchone()
        valid_password, _canonical_password, _should_rehash = verify_password(row["password_hash"], old_password) if row else (False, "", False)
        if not row or not valid_password:
            raise ApiError("Current password is incorrect.", 401)
        conn.execute("UPDATE users SET password_hash=%s, session_version=session_version+1 WHERE id=%s", (generate_password_hash(new_password), request.user["id"]))
        version = conn.execute("SELECT session_version FROM users WHERE id=%s", (request.user["id"],)).fetchone()["session_version"]
    session["session_version"] = int(version)
    return jsonify({"ok": True})


@app.post("/api/reset-password")
def api_reset_password():
    data = read_json()
    email = str(data.get("email", "")).strip().lower()
    new_password = normalize_password(data.get("new_password", ""))
    recovery = parse_recovery_answers(data)
    if "@" not in email or len(email) > 254:
        raise ApiError("Enter a valid email address.")
    if len(new_password) < 8:
        raise ApiError("Choose a new password with at least 8 characters.")

    success = False
    locked = False
    with database_connection() as conn:
        conn.execute(
            "INSERT INTO password_reset_attempts(email) VALUES(%s) ON CONFLICT(email) DO NOTHING",
            (email,),
        )
        attempts = conn.execute("SELECT attempt_count, window_started_at, locked_until FROM password_reset_attempts WHERE email=%s FOR UPDATE", (email,)).fetchone()
        if attempts["locked_until"] and attempts["locked_until"] > conn.execute("SELECT NOW() AS now").fetchone()["now"]:
            locked = True
        else:
            if attempts["window_started_at"] < conn.execute("SELECT NOW() - INTERVAL '30 minutes' AS cutoff").fetchone()["cutoff"]:
                conn.execute("UPDATE password_reset_attempts SET attempt_count=1, window_started_at=NOW(), locked_until=NULL WHERE email=%s", (email,))
            elif attempts["attempt_count"] >= 5:
                conn.execute("UPDATE password_reset_attempts SET locked_until=NOW() + INTERVAL '30 minutes' WHERE email=%s", (email,))
                locked = True
            else:
                conn.execute("UPDATE password_reset_attempts SET attempt_count=attempt_count+1 WHERE email=%s", (email,))

            if not locked:
                user = conn.execute("SELECT id FROM users WHERE email=%s AND active=TRUE", (email,)).fetchone()
                if user:
                    stored = conn.execute("SELECT question_key, answer_hash FROM recovery_questions WHERE user_id=%s", (user["id"],)).fetchall()
                    hashes = {row["question_key"]: row["answer_hash"] for row in stored}
                    if len(hashes) == 3 and all(key in hashes and check_password_hash(hashes[key], answer) for key, answer in recovery):
                        conn.execute("UPDATE users SET password_hash=%s, session_version=session_version+1 WHERE id=%s", (generate_password_hash(new_password), user["id"]))
                        conn.execute("DELETE FROM password_reset_attempts WHERE email=%s", (email,))
                        success = True
    if locked:
        raise ApiError("Too many reset attempts. Try again in 30 minutes.", 429)
    if not success:
        raise ApiError("We could not verify those details. Check the email and all three answers, then try again.", 400)
    return jsonify({"ok": True, "message": "Password reset. Sign in with your new password."})


def course_select_sql():
    return """SELECT c.id, c.code, c.title, c.description, c.image_url, c.course_video_url,
                     c.is_paid, c.price, c.published, c.created_at,
                     COUNT(DISTINCT t.id)::int AS topic_count,
                     COUNT(DISTINCT CASE WHEN tp.completed THEN tp.topic_id END)::int AS completed_count,
                     BOOL_OR(e.status = 'active') AS enrolled
              FROM courses c
              LEFT JOIN topics t ON t.course_id = c.id
              LEFT JOIN enrollments e ON e.course_id = c.id AND e.user_id = %s
              LEFT JOIN topic_progress tp ON tp.topic_id = t.id AND tp.user_id = %s"""


@app.get("/api/courses")
def api_courses():
    query = str(request.args.get("q", "")).strip()
    user_id = session.get("user_id") or 0
    with database_connection() as conn:
        courses = conn.execute(
            course_select_sql() + " WHERE c.published = TRUE AND (%s = '' OR c.title ILIKE %s OR c.code ILIKE %s) GROUP BY c.id ORDER BY c.title",
            (user_id, user_id, query, f"%{query}%", f"%{query}%"),
        ).fetchall()
    return jsonify({"courses": courses})


@app.get("/api/courses/<int:course_id>")
def api_course(course_id):
    user_id = session.get("user_id") or 0
    # Resolve the viewer before checking out this route's connection so we do
    # not hold one pooled connection while current_user() tries to borrow another.
    viewer = current_user() if session.get("user_id") else None
    with database_connection() as conn:
        course = conn.execute(
            course_select_sql() + " WHERE c.id = %s AND (c.published = TRUE OR %s IN (SELECT id FROM users WHERE role = 'admin')) GROUP BY c.id",
            (user_id, user_id, course_id, user_id),
        ).fetchone()
        if not course:
            raise ApiError("Course not found.", 404)
        has_access = bool(course["enrolled"]) or bool(viewer and viewer["role"] == "admin")
        topics = conn.execute(
            """SELECT t.id, t.title, t.description, t.video_url, t.resource_url, t.sort_order,
                      COALESCE(tp.completed, FALSE) AS completed
               FROM topics t LEFT JOIN topic_progress tp ON tp.topic_id = t.id AND tp.user_id = %s
               WHERE t.course_id = %s ORDER BY t.sort_order, t.id""",
            (user_id, course_id),
        ).fetchall()
        payment_status = None
        completion_status = "in_progress"
        completion_review_note = ""
        if session.get("user_id"):
            enrollment = conn.execute(
                "SELECT completion_status, completion_review_note FROM enrollments WHERE user_id=%s AND course_id=%s AND status='active'",
                (user_id, course_id),
            ).fetchone()
            if enrollment:
                completion_status = enrollment["completion_status"]
                completion_review_note = enrollment["completion_review_note"]
        if session.get("user_id") and course["is_paid"] and not course["enrolled"]:
            latest_payment = conn.execute(
                "SELECT status FROM payment_requests WHERE user_id=%s AND course_id=%s ORDER BY created_at DESC LIMIT 1",
                (user_id, course_id),
            ).fetchone()
            payment_status = latest_payment["status"] if latest_payment else None
    if not has_access:
        topics = [{"id": t["id"], "title": t["title"], "sort_order": t["sort_order"], "locked": True} for t in topics]
    course["topics"] = topics
    course["has_access"] = bool(has_access)
    course["is_enrolled"] = bool(course["enrolled"])
    course["payment_status"] = payment_status
    course["completion_status"] = completion_status
    course["completion_review_note"] = completion_review_note
    return jsonify({"course": course})


@app.post("/api/courses/<int:course_id>/enroll")
@require_login
def api_enroll(course_id):
    with database_connection() as conn:
        course = conn.execute("SELECT id, is_paid, published FROM courses WHERE id = %s", (course_id,)).fetchone()
        if not course or not course["published"]:
            raise ApiError("Course not found.", 404)
        if course["is_paid"]:
            raise ApiError("This course needs payment approval. Submit a payment reference instead.", 400)
        conn.execute(
            "INSERT INTO enrollments (user_id, course_id) VALUES (%s, %s) ON CONFLICT (user_id, course_id) DO UPDATE SET status = 'active'",
            (request.user["id"], course_id),
        )
    return jsonify({"ok": True})


@app.post("/api/courses/<int:course_id>/payment-requests")
@require_login
def api_payment_request(course_id):
    data = read_json()
    utr = str(data.get("utr", "")).strip().upper()
    if len(utr) < 6 or len(utr) > 80:
        raise ApiError("Enter the UTR/reference number from your UPI app (at least 6 characters).")
    raw_date = str(data.get("payment_date", "")).strip()
    paid_date = None
    if raw_date:
        try:
            paid_date = date.fromisoformat(raw_date)
        except ValueError as exc:
            raise ApiError("Enter a valid payment date.") from exc
    with database_connection() as conn:
        course = conn.execute("SELECT id, is_paid, price, published FROM courses WHERE id = %s", (course_id,)).fetchone()
        if not course or not course["published"]:
            raise ApiError("Course not found.", 404)
        if not course["is_paid"]:
            raise ApiError("This course is free. Enroll directly.")
        existing = conn.execute("SELECT id FROM enrollments WHERE user_id = %s AND course_id = %s AND status = 'active'", (request.user["id"], course_id)).fetchone()
        if existing:
            raise ApiError("You already have access to this course.", 409)
        pending = conn.execute("SELECT id FROM payment_requests WHERE user_id = %s AND course_id = %s AND status = 'pending'", (request.user["id"], course_id)).fetchone()
        if pending:
            raise ApiError("You already have a payment waiting for review. Check Payment Status.", 409)
        try:
            with conn.transaction():
                payment = conn.execute(
                    """INSERT INTO payment_requests (user_id, course_id, amount, utr, payment_date)
                       VALUES (%s, %s, %s, %s, %s) RETURNING id, status""",
                    (request.user["id"], course_id, course["price"], utr, paid_date),
                ).fetchone()
        except UniqueViolation as exc:
            raise ApiError("This UTR/reference number has already been submitted.", 409) from exc
    return jsonify({"payment": payment, "message": "Payment details submitted. Course access will be added after admin verification."}), 201


@app.get("/api/payment-settings")
def api_payment_settings():
    with database_connection() as conn:
        settings = {r["setting_key"]: r["setting_value"] for r in conn.execute("SELECT setting_key, setting_value FROM app_settings").fetchall()}
    return jsonify({"settings": {"upi_id": settings.get("upi_id", ""), "qr_image_url": settings.get("qr_image_url", ""), "payment_instructions": settings.get("payment_instructions", "")}})


@app.get("/api/me/courses")
@require_login
def api_my_courses():
    with database_connection() as conn:
        courses = conn.execute(
            """SELECT c.id, c.code, c.title, c.description, c.image_url, c.course_video_url, c.is_paid, c.price,
                      e.created_at AS enrolled_at, COUNT(DISTINCT t.id)::int AS topic_count,
                      COUNT(DISTINCT CASE WHEN tp.completed THEN tp.topic_id END)::int AS completed_count,
                      e.completion_status, e.completion_submitted_at, e.completion_review_note,
                      COALESCE((SELECT q.published FROM quizzes q WHERE q.course_id=c.id),FALSE) AS quiz_published,
                      (SELECT COUNT(*)::int FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id=q.id WHERE q.course_id=c.id) AS quiz_question_count,
                      (SELECT qa.score FROM quiz_attempts qa WHERE qa.user_id=e.user_id AND qa.course_id=c.id ORDER BY qa.score DESC, qa.created_at DESC LIMIT 1) AS best_quiz_score,
                      (SELECT cert.certificate_code::text FROM certificates cert WHERE cert.user_id=e.user_id AND cert.course_id=c.id LIMIT 1) AS certificate_code
               FROM enrollments e JOIN courses c ON c.id = e.course_id
               LEFT JOIN topics t ON t.course_id = c.id
               LEFT JOIN topic_progress tp ON tp.topic_id = t.id AND tp.user_id = e.user_id
               WHERE e.user_id = %s AND e.status = 'active'
               GROUP BY c.id, e.created_at ORDER BY e.created_at DESC""",
            (request.user["id"],),
        ).fetchall()
    return jsonify({"courses": courses})


@app.get("/api/me/dashboard")
@require_login
def api_my_dashboard():
    user_id = request.user["id"]
    with database_connection() as conn:
        courses = conn.execute(
            """SELECT c.id, c.code, c.title, c.description, c.image_url, c.course_video_url, c.is_paid, c.price,
                      e.created_at AS enrolled_at, COUNT(DISTINCT t.id)::int AS topic_count,
                      COUNT(DISTINCT CASE WHEN tp.completed THEN tp.topic_id END)::int AS completed_count,
                      e.completion_status, e.completion_submitted_at, e.completion_review_note,
                      COALESCE((SELECT q.published FROM quizzes q WHERE q.course_id=c.id),FALSE) AS quiz_published,
                      (SELECT COUNT(*)::int FROM quizzes q JOIN quiz_questions qq ON qq.quiz_id=q.id WHERE q.course_id=c.id) AS quiz_question_count,
                      (SELECT qa.score FROM quiz_attempts qa WHERE qa.user_id=e.user_id AND qa.course_id=c.id ORDER BY qa.score DESC, qa.created_at DESC LIMIT 1) AS best_quiz_score,
                      (SELECT cert.certificate_code::text FROM certificates cert WHERE cert.user_id=e.user_id AND cert.course_id=c.id LIMIT 1) AS certificate_code
               FROM enrollments e JOIN courses c ON c.id=e.course_id
               LEFT JOIN topics t ON t.course_id=c.id
               LEFT JOIN topic_progress tp ON tp.topic_id=t.id AND tp.user_id=e.user_id
               WHERE e.user_id=%s AND e.status='active'
               GROUP BY c.id,e.id ORDER BY e.created_at DESC""",
            (user_id,),
        ).fetchall()
        payments = conn.execute(
            """SELECT p.id,p.amount,p.utr,p.payment_date,p.status,p.admin_note,p.created_at,p.reviewed_at,
                      c.code AS course_code,c.title AS course_title
               FROM payment_requests p JOIN courses c ON c.id=p.course_id
               WHERE p.user_id=%s ORDER BY p.created_at DESC LIMIT 50""",
            (user_id,),
        ).fetchall()
        summary = conn.execute(
            """SELECT (SELECT COUNT(*)::int FROM enrollments WHERE user_id=%s AND status='active') AS enrolled_courses,
                      (SELECT COUNT(*)::int FROM topic_progress tp JOIN topics t ON t.id=tp.topic_id JOIN enrollments e ON e.user_id=tp.user_id AND e.course_id=t.course_id AND e.status='active' WHERE tp.user_id=%s AND tp.completed=TRUE) AS completed_topics,
                      (SELECT COUNT(*)::int FROM topics t JOIN enrollments e ON e.course_id=t.course_id AND e.user_id=%s AND e.status='active') AS available_topics,
                      (SELECT COUNT(*)::int FROM payment_requests WHERE user_id=%s AND status='pending') AS pending_payments,
                      (SELECT COUNT(*)::int FROM certificates WHERE user_id=%s) AS certificates,
                      (SELECT COUNT(*)::int FROM enrollments WHERE user_id=%s AND completion_status='pending') AS pending_completions""",
            (user_id,user_id,user_id,user_id,user_id,user_id),
        ).fetchone()
        question_count = conn.execute("SELECT COUNT(*)::int AS count FROM recovery_questions WHERE user_id=%s", (user_id,)).fetchone()["count"]
    return jsonify({"summary": summary, "courses": courses, "payments": payments, "recovery_question_count": question_count})


@app.post("/api/courses/<int:course_id>/completion-request")
@require_login
def api_completion_request(course_id):
    with database_connection() as conn:
        enrollment = conn.execute(
            "SELECT id,completion_status FROM enrollments WHERE user_id=%s AND course_id=%s AND status='active' FOR UPDATE",
            (request.user["id"], course_id),
        ).fetchone()
        if not enrollment:
            raise ApiError("Enroll in this course before requesting completion approval.", 403)
        progress = conn.execute(
            """SELECT COUNT(*)::int AS total,COUNT(tp.topic_id)::int AS completed
               FROM topics t LEFT JOIN topic_progress tp ON tp.topic_id=t.id AND tp.user_id=%s AND tp.completed=TRUE
               WHERE t.course_id=%s""",
            (request.user["id"], course_id),
        ).fetchone()
        if progress["total"] == 0 or progress["completed"] != progress["total"]:
            raise ApiError("Mark every course topic complete before asking for review.")
        if enrollment["completion_status"] == "approved":
            raise ApiError("This course completion has already been approved.", 409)
        if enrollment["completion_status"] == "pending":
            raise ApiError("Your completion request is already waiting for review.", 409)
        conn.execute(
            """UPDATE enrollments SET completion_status='pending',completion_submitted_at=NOW(),
                      completion_reviewed_by=NULL,completion_reviewed_at=NULL,completion_review_note=''
               WHERE id=%s""",
            (enrollment["id"],),
        )
    return jsonify({"ok": True, "message": "Completion sent for admin review."}), 201


@app.get("/api/me/payments")
@require_login
def api_my_payments():
    with database_connection() as conn:
        payments = conn.execute(
            """SELECT p.id, p.amount, p.utr, p.payment_date, p.status, p.admin_note, p.created_at, p.reviewed_at,
                      c.code AS course_code, c.title AS course_title
               FROM payment_requests p JOIN courses c ON c.id = p.course_id
               WHERE p.user_id = %s ORDER BY p.created_at DESC""",
            (request.user["id"],),
        ).fetchall()
    return jsonify({"payments": payments})


@app.post("/api/topics/<int:topic_id>/complete")
@require_login
def api_complete_topic(topic_id):
    with database_connection() as conn:
        topic = conn.execute(
            """SELECT t.id, t.course_id FROM topics t JOIN courses c ON c.id = t.course_id
               WHERE t.id = %s AND c.published = TRUE""",
            (topic_id,),
        ).fetchone()
        if not topic:
            raise ApiError("Topic not found.", 404)
        access = request.user["role"] == "admin" or conn.execute(
            "SELECT 1 FROM enrollments WHERE user_id = %s AND course_id = %s AND status = 'active'",
            (request.user["id"], topic["course_id"]),
        ).fetchone()
        if not access:
            raise ApiError("Enroll in the course before marking a topic complete.", 403)
        conn.execute(
            """INSERT INTO topic_progress (user_id, topic_id) VALUES (%s, %s)
               ON CONFLICT (user_id, topic_id) DO UPDATE SET completed = TRUE, completed_at = NOW()""",
            (request.user["id"], topic_id),
        )
    return jsonify({"ok": True})


@app.get("/api/admin/overview")
@require_admin
def api_admin_overview():
    with database_connection() as conn:
        summary = conn.execute(
            """SELECT (SELECT COUNT(*) FROM users WHERE role = 'student')::int AS users,
                      (SELECT COUNT(*) FROM courses)::int AS courses,
                      (SELECT COUNT(*) FROM enrollments WHERE status = 'active')::int AS enrollments,
                      (SELECT COUNT(*) FROM payment_requests WHERE status = 'pending')::int AS pending_payments,
                      (SELECT COUNT(*) FROM enrollments WHERE completion_status = 'pending')::int AS pending_completions,
                      (SELECT COUNT(*) FROM quiz_attempts WHERE passed = TRUE)::int AS quizzes_passed,
                      (SELECT COUNT(*) FROM certificates)::int AS certificates_issued,
                      COALESCE((SELECT SUM(amount) FROM payment_requests WHERE status = 'approved'), 0)::numeric(12,2) AS verified_revenue,
                      COALESCE((SELECT SUM(amount) FROM payment_requests WHERE status = 'approved' AND reviewed_at >= NOW() - INTERVAL '30 days'), 0)::numeric(12,2) AS revenue_30_days"""
        ).fetchone()
        latest = conn.execute(
            """SELECT c.id, c.code, c.title, COUNT(DISTINCT e.user_id)::int AS students,
                      COUNT(DISTINCT t.id)::int AS topics,
                      COUNT(DISTINCT CASE WHEN tp.completed THEN (tp.user_id::text || ':' || tp.topic_id::text) END)::int AS completed_topics
               FROM courses c LEFT JOIN enrollments e ON e.course_id = c.id AND e.status = 'active'
               LEFT JOIN topics t ON t.course_id = c.id
               LEFT JOIN topic_progress tp ON tp.topic_id = t.id
               GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 8"""
        ).fetchall()
    return jsonify({"summary": summary, "courses": latest})


@app.get("/api/admin/completions")
@require_admin
def api_admin_completions():
    with database_connection() as conn:
        rows = conn.execute(
            """SELECT e.id AS enrollment_id,e.user_id,e.course_id,e.completion_submitted_at,
                      u.name AS user_name,u.email AS user_email,c.code AS course_code,c.title AS course_title,
                      COUNT(DISTINCT t.id)::int AS topic_count,
                      COUNT(DISTINCT CASE WHEN tp.completed THEN tp.topic_id END)::int AS completed_count
               FROM enrollments e JOIN users u ON u.id=e.user_id JOIN courses c ON c.id=e.course_id
               LEFT JOIN topics t ON t.course_id=c.id
               LEFT JOIN topic_progress tp ON tp.topic_id=t.id AND tp.user_id=e.user_id
               WHERE e.status='active' AND e.completion_status='pending'
               GROUP BY e.id,u.id,c.id ORDER BY e.completion_submitted_at"""
        ).fetchall()
    return jsonify({"completions": rows})


@app.post("/api/admin/completions/<int:enrollment_id>/decision")
@require_admin
def api_admin_completion_decision(enrollment_id):
    data = read_json()
    decision = str(data.get("decision", "")).lower()
    note = str(data.get("note", "")).strip()[:1000]
    if decision not in {"approve", "reject"}:
        raise ApiError("Choose approve or reject.")
    if decision == "reject" and not note:
        raise ApiError("Add a reason before returning a completion request.")
    status = "approved" if decision == "approve" else "rejected"
    with database_connection() as conn:
        enrollment = conn.execute(
            "SELECT id,user_id,course_id,completion_status FROM enrollments WHERE id=%s AND status='active' FOR UPDATE",
            (enrollment_id,),
        ).fetchone()
        if not enrollment or enrollment["completion_status"] != "pending":
            raise ApiError("This completion request is no longer waiting for review.", 409)
        progress = conn.execute(
            """SELECT COUNT(*)::int AS total,COUNT(tp.topic_id)::int AS completed
               FROM topics t LEFT JOIN topic_progress tp ON tp.topic_id=t.id AND tp.user_id=%s AND tp.completed=TRUE
               WHERE t.course_id=%s""",
            (enrollment["user_id"], enrollment["course_id"]),
        ).fetchone()
        if decision == "approve" and (progress["total"] == 0 or progress["completed"] != progress["total"]):
            raise ApiError("Every topic must still be marked complete before approval.", 409)
        conn.execute(
            """UPDATE enrollments SET completion_status=%s,completion_reviewed_by=%s,
                      completion_reviewed_at=NOW(),completion_review_note=%s WHERE id=%s""",
            (status, request.user["id"], note, enrollment_id),
        )
    return jsonify({"ok": True, "status": status})


@app.post("/api/admin/completions/bulk-approve")
@require_admin
def api_admin_bulk_approve_completions():
    raw_ids = read_json().get("enrollment_ids", [])
    if not isinstance(raw_ids, list) or not raw_ids or len(raw_ids) > 300:
        raise ApiError("Select between 1 and 300 completion requests.")
    try:
        ids = list(dict.fromkeys(int(value) for value in raw_ids))
    except (TypeError, ValueError) as exc:
        raise ApiError("The selected completion list is invalid.") from exc
    if len(ids) != len(raw_ids):
        raise ApiError("A completion request was selected more than once.")
    with database_connection() as conn:
        rows = conn.execute(
            """SELECT e.id,e.user_id,e.course_id,COUNT(DISTINCT t.id)::int AS total,
                      COUNT(DISTINCT CASE WHEN tp.completed THEN tp.topic_id END)::int AS completed
               FROM enrollments e LEFT JOIN topics t ON t.course_id=e.course_id
               LEFT JOIN topic_progress tp ON tp.topic_id=t.id AND tp.user_id=e.user_id
               WHERE e.id=ANY(%s) AND e.status='active' AND e.completion_status='pending'
               GROUP BY e.id""",
            (ids,),
        ).fetchall()
        if len(rows) != len(ids):
            raise ApiError("One or more selected requests are no longer pending. Refresh and select again.", 409)
        incomplete = [row for row in rows if row["total"] == 0 or row["completed"] != row["total"]]
        if incomplete:
            raise ApiError("At least one selected course has topics that are not complete. No requests were approved.", 409)
        conn.execute(
            """UPDATE enrollments SET completion_status='approved',completion_reviewed_by=%s,
                      completion_reviewed_at=NOW(),completion_review_note='Approved in bulk'
               WHERE id=ANY(%s)""",
            (request.user["id"], ids),
        )
    return jsonify({"ok": True, "approved": len(ids)})


@app.get("/api/admin/courses")
@require_admin
def api_admin_courses():
    with database_connection() as conn:
        courses = conn.execute(
            """SELECT c.id, c.code, c.title, c.description, c.image_url, c.course_video_url, c.is_paid, c.price, c.published,
                      COUNT(DISTINCT t.id)::int AS topic_count, COUNT(DISTINCT e.user_id)::int AS student_count
               FROM courses c LEFT JOIN topics t ON t.course_id = c.id
               LEFT JOIN enrollments e ON e.course_id = c.id AND e.status = 'active'
               GROUP BY c.id ORDER BY c.updated_at DESC"""
        ).fetchall()
    return jsonify({"courses": courses})


def course_values(data):
    code = str(data.get("code", "")).strip().upper()
    title = str(data.get("title", "")).strip()
    description = str(data.get("description", "")).strip()
    image_url = str(data.get("image_url", "")).strip()
    video_url = str(data.get("course_video_url", "")).strip()
    is_paid = bool(data.get("is_paid", False))
    try:
        price = Decimal(str(data.get("price", "0") or "0"))
        if not price.is_finite() or price < 0 or price > Decimal("99999999"):
            raise InvalidOperation
    except (InvalidOperation, ValueError) as exc:
        raise ApiError("Enter a valid non-negative course price.") from exc
    published = bool(data.get("published", False))
    if not code or len(code) > 60 or not title or len(title) > 200:
        raise ApiError("Course code and title are required (maximum 60 and 200 characters).")
    if not is_paid:
        price = Decimal("0")
    return code, title, description, image_url, video_url, is_paid, price, published


@app.post("/api/admin/courses")
@require_admin
def api_admin_create_course():
    values = course_values(read_json())
    with database_connection() as conn:
        course = conn.execute(
            """INSERT INTO courses (code, title, description, image_url, course_video_url, is_paid, price, published)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""", values,
        ).fetchone()
    return jsonify({"id": course["id"]}), 201


@app.patch("/api/admin/courses/<int:course_id>")
@require_admin
def api_admin_update_course(course_id):
    values = course_values(read_json())
    with database_connection() as conn:
        result = conn.execute(
            """UPDATE courses SET code=%s, title=%s, description=%s, image_url=%s, course_video_url=%s,
                      is_paid=%s, price=%s, published=%s, updated_at=NOW() WHERE id=%s RETURNING id""",
            (*values, course_id),
        ).fetchone()
        if not result:
            raise ApiError("Course not found.", 404)
    return jsonify({"ok": True})


@app.delete("/api/admin/courses/<int:course_id>")
@require_admin
def api_admin_delete_course(course_id):
    with database_connection() as conn:
        course = conn.execute("SELECT id FROM courses WHERE id=%s", (course_id,)).fetchone()
        if not course:
            raise ApiError("Course not found.", 404)
        history = conn.execute(
            """SELECT EXISTS(SELECT 1 FROM enrollments WHERE course_id=%s)
                      OR EXISTS(SELECT 1 FROM payment_requests WHERE course_id=%s) AS has_history""",
            (course_id, course_id),
        ).fetchone()["has_history"]
        if history:
            conn.execute("UPDATE courses SET published=FALSE, updated_at=NOW() WHERE id=%s", (course_id,))
            return jsonify({"ok": True, "archived": True})
        conn.execute("DELETE FROM courses WHERE id=%s", (course_id,))
    return jsonify({"ok": True, "archived": False})


@app.get("/api/admin/courses/<int:course_id>/topics")
@require_admin
def api_admin_topics(course_id):
    with database_connection() as conn:
        course = conn.execute("SELECT id, code, title FROM courses WHERE id=%s", (course_id,)).fetchone()
        if not course:
            raise ApiError("Course not found.", 404)
        topics = conn.execute("SELECT id, title, description, video_url, resource_url, sort_order FROM topics WHERE course_id=%s ORDER BY sort_order, id", (course_id,)).fetchall()
    return jsonify({"course": course, "topics": topics})


def topic_values(data):
    title = str(data.get("title", "")).strip()
    if not title or len(title) > 200:
        raise ApiError("Enter a topic title (maximum 200 characters).")
    try:
        sort_order = int(data.get("sort_order", 1))
    except (TypeError, ValueError) as exc:
        raise ApiError("Sort order must be a whole number.") from exc
    return title, str(data.get("description", "")).strip(), str(data.get("video_url", "")).strip(), str(data.get("resource_url", "")).strip(), sort_order


@app.post("/api/admin/courses/<int:course_id>/topics")
@require_admin
def api_admin_create_topic(course_id):
    values = topic_values(read_json())
    with database_connection() as conn:
        if not conn.execute("SELECT 1 FROM courses WHERE id=%s", (course_id,)).fetchone():
            raise ApiError("Course not found.", 404)
        topic = conn.execute(
            """INSERT INTO topics (course_id, title, description, video_url, resource_url, sort_order)
               VALUES (%s,%s,%s,%s,%s,%s) RETURNING id""", (course_id, *values),
        ).fetchone()
    return jsonify({"id": topic["id"]}), 201


@app.patch("/api/admin/topics/<int:topic_id>")
@require_admin
def api_admin_update_topic(topic_id):
    values = topic_values(read_json())
    with database_connection() as conn:
        result = conn.execute(
            """UPDATE topics SET title=%s, description=%s, video_url=%s, resource_url=%s, sort_order=%s
               WHERE id=%s RETURNING id""", (*values, topic_id),
        ).fetchone()
        if not result:
            raise ApiError("Topic not found.", 404)
    return jsonify({"ok": True})


@app.delete("/api/admin/topics/<int:topic_id>")
@require_admin
def api_admin_delete_topic(topic_id):
    with database_connection() as conn:
        result = conn.execute("DELETE FROM topics WHERE id=%s RETURNING id", (topic_id,)).fetchone()
        if not result:
            raise ApiError("Topic not found.", 404)
    return jsonify({"ok": True})


@app.get("/api/admin/payments")
@require_admin
def api_admin_payments():
    status = str(request.args.get("status", "all")).lower()
    if status not in {"all", "pending", "approved", "rejected"}:
        status = "all"
    with database_connection() as conn:
        payments = conn.execute(
            """SELECT p.id, p.amount, p.utr, p.payment_date, p.status, p.admin_note, p.created_at, p.reviewed_at,
                      u.id AS user_id, u.name AS user_name, u.email AS user_email,
                      c.id AS course_id, c.code AS course_code, c.title AS course_title,
                      EXISTS (SELECT 1 FROM payment_requests dup WHERE LOWER(dup.utr)=LOWER(p.utr) AND dup.id<>p.id) AS duplicate_utr
               FROM payment_requests p JOIN users u ON u.id=p.user_id JOIN courses c ON c.id=p.course_id
               WHERE (%s='all' OR p.status=%s) ORDER BY CASE WHEN p.status='pending' THEN 0 ELSE 1 END, p.created_at DESC LIMIT 300""",
            (status, status),
        ).fetchall()
    return jsonify({"payments": payments})


@app.post("/api/admin/payments/<int:payment_id>/decision")
@require_admin
def api_admin_payment_decision(payment_id):
    data = read_json()
    decision = str(data.get("decision", "")).lower()
    note = str(data.get("note", "")).strip()[:1000]
    if decision not in {"approve", "reject"}:
        raise ApiError("Choose approve or reject.")
    if decision == "reject" and not note:
        raise ApiError("Add a short reason before rejecting the payment.")
    status = "approved" if decision == "approve" else "rejected"
    with database_connection() as conn:
        payment = conn.execute("SELECT id, user_id, course_id, status, utr FROM payment_requests WHERE id=%s FOR UPDATE", (payment_id,)).fetchone()
        if not payment:
            raise ApiError("Payment request not found.", 404)
        if payment["status"] != "pending":
            raise ApiError("This payment request has already been reviewed.", 409)
        duplicate_count = conn.execute(
            "SELECT COUNT(*)::int AS count FROM payment_requests WHERE LOWER(utr)=LOWER(%s)",
            (payment["utr"],),
        ).fetchone()["count"]
        if decision == "approve" and duplicate_count > 1:
            raise ApiError("This UTR appears on more than one request. Review the duplicate before approving either payment.", 409)
        conn.execute(
            "UPDATE payment_requests SET status=%s, admin_note=%s, reviewed_by=%s, reviewed_at=NOW() WHERE id=%s",
            (status, note, request.user["id"], payment_id),
        )
        if decision == "approve":
            conn.execute(
                """INSERT INTO enrollments (user_id, course_id) VALUES (%s,%s)
                   ON CONFLICT (user_id,course_id) DO UPDATE SET status='active'""",
                (payment["user_id"], payment["course_id"]),
            )
    return jsonify({"ok": True, "status": status})


@app.get("/api/admin/users")
@require_admin
def api_admin_users():
    query = str(request.args.get("q", "")).strip()
    with database_connection() as conn:
        users = conn.execute(
            """SELECT u.id, u.name, u.email, u.role, u.active, u.created_at, u.last_login,
                      COUNT(DISTINCT e.course_id)::int AS course_count
               FROM users u LEFT JOIN enrollments e ON e.user_id=u.id AND e.status='active'
               WHERE u.role='student' AND (%s='' OR u.name ILIKE %s OR u.email ILIKE %s)
               GROUP BY u.id ORDER BY u.created_at DESC LIMIT 300""",
            (query, f"%{query}%", f"%{query}%"),
        ).fetchall()
    return jsonify({"users": users})


@app.get("/api/admin/settings")
@require_admin
def api_admin_get_settings():
    with database_connection() as conn:
        settings = {r["setting_key"]: r["setting_value"] for r in conn.execute("SELECT setting_key, setting_value FROM app_settings").fetchall()}
    return jsonify({"settings": {"upi_id": settings.get("upi_id", ""), "qr_image_url": settings.get("qr_image_url", ""), "payment_instructions": settings.get("payment_instructions", "")}})


@app.put("/api/admin/settings")
@require_admin
def api_admin_save_settings():
    data = read_json()
    values = {
        "upi_id": str(data.get("upi_id", "")).strip()[:150],
        "qr_image_url": str(data.get("qr_image_url", "")).strip()[:1000],
        "payment_instructions": str(data.get("payment_instructions", "")).strip()[:2000],
    }
    with database_connection() as conn:
        for key, value in values.items():
            conn.execute(
                """INSERT INTO app_settings(setting_key, setting_value) VALUES(%s,%s)
                   ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value, updated_at=NOW()""",
                (key, value),
            )
    return jsonify({"ok": True})


@app.get("/api/admin/quizzes")
@require_admin
def api_admin_quizzes():
    with database_connection() as conn:
        quizzes = conn.execute(
            """SELECT c.id AS course_id,c.code,c.title,
                      q.id AS quiz_id,COALESCE(q.title,'Course completion quiz') AS quiz_title,
                      COALESCE(q.published,FALSE) AS published,COALESCE(q.pass_percentage,90)::numeric AS pass_percentage,
                      COUNT(qq.id)::int AS question_count
               FROM courses c LEFT JOIN quizzes q ON q.course_id=c.id
               LEFT JOIN quiz_questions qq ON qq.quiz_id=q.id
               GROUP BY c.id,q.id ORDER BY c.title"""
        ).fetchall()
    return jsonify({"quizzes": quizzes})


@app.get("/api/admin/courses/<int:course_id>/quiz")
@require_admin
def api_admin_course_quiz(course_id):
    with database_connection() as conn:
        course = conn.execute("SELECT id,code,title FROM courses WHERE id=%s", (course_id,)).fetchone()
        if not course:
            raise ApiError("Course not found.", 404)
        quiz = conn.execute("SELECT id,title,published,pass_percentage FROM quizzes WHERE course_id=%s", (course_id,)).fetchone()
        questions = []
        if quiz:
            questions = conn.execute(
                "SELECT id,prompt,options,correct_option,sort_order FROM quiz_questions WHERE quiz_id=%s ORDER BY sort_order,id",
                (quiz["id"],),
            ).fetchall()
    return jsonify({"course": course, "quiz": quiz, "questions": questions})


@app.put("/api/admin/courses/<int:course_id>/quiz")
@require_admin
def api_admin_save_quiz(course_id):
    data = read_json()
    title = str(data.get("title", "Course completion quiz")).strip()[:200] or "Course completion quiz"
    try:
        pass_percentage = Decimal(str(data.get("pass_percentage", "90")))
        if not pass_percentage.is_finite() or pass_percentage < Decimal("90") or pass_percentage > Decimal("100"):
            raise InvalidOperation
    except (InvalidOperation, ValueError) as exc:
        raise ApiError("The passing score must be between 90 and 100 percent.") from exc
    published = bool(data.get("published", False))
    with database_connection() as conn:
        if not conn.execute("SELECT 1 FROM courses WHERE id=%s", (course_id,)).fetchone():
            raise ApiError("Course not found.", 404)
        quiz = conn.execute(
            """INSERT INTO quizzes(course_id,title,published,pass_percentage) VALUES(%s,%s,%s,%s)
               ON CONFLICT(course_id) DO UPDATE SET title=EXCLUDED.title,published=EXCLUDED.published,
               pass_percentage=EXCLUDED.pass_percentage,updated_at=NOW() RETURNING id""",
            (course_id, title, published, pass_percentage),
        ).fetchone()
    return jsonify({"id": quiz["id"]})


def validate_quiz_question(data):
    prompt = str(data.get("prompt", "")).strip()
    options = data.get("options")
    if not isinstance(options, list):
        raise ApiError("Add between two and six answer choices.")
    options = [str(option).strip() for option in options]
    if not prompt or len(prompt) > 1000 or len(options) < 2 or len(options) > 6 or any(not option or len(option) > 500 for option in options):
        raise ApiError("Enter a question and two to six non-empty answer choices.")
    try:
        correct_option = int(data.get("correct_option"))
        sort_order = int(data.get("sort_order", 1))
    except (TypeError, ValueError) as exc:
        raise ApiError("Select the correct answer and enter a whole-number order.") from exc
    if correct_option < 0 or correct_option >= len(options):
        raise ApiError("Select which answer choice is correct.")
    return prompt, options, correct_option, sort_order


@app.post("/api/admin/courses/<int:course_id>/quiz/questions")
@require_admin
def api_admin_add_quiz_question(course_id):
    prompt, options, correct_option, sort_order = validate_quiz_question(read_json())
    with database_connection() as conn:
        if not conn.execute("SELECT 1 FROM courses WHERE id=%s", (course_id,)).fetchone():
            raise ApiError("Course not found.", 404)
        quiz = conn.execute(
            "INSERT INTO quizzes(course_id) VALUES(%s) ON CONFLICT(course_id) DO UPDATE SET updated_at=NOW() RETURNING id",
            (course_id,),
        ).fetchone()
        if sort_order <= 0:
            sort_order = conn.execute("SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM quiz_questions WHERE quiz_id=%s", (quiz["id"],)).fetchone()["next"]
        question = conn.execute(
            "INSERT INTO quiz_questions(quiz_id,prompt,options,correct_option,sort_order) VALUES(%s,%s,%s,%s,%s) RETURNING id",
            (quiz["id"], prompt, Jsonb(options), correct_option, sort_order),
        ).fetchone()
        conn.execute("UPDATE quizzes SET updated_at=NOW() WHERE id=%s", (quiz["id"],))
    return jsonify({"id": question["id"]}), 201


@app.patch("/api/admin/quiz-questions/<int:question_id>")
@require_admin
def api_admin_update_quiz_question(question_id):
    prompt, options, correct_option, sort_order = validate_quiz_question(read_json())
    with database_connection() as conn:
        result = conn.execute(
            "UPDATE quiz_questions SET prompt=%s,options=%s,correct_option=%s,sort_order=%s WHERE id=%s RETURNING quiz_id",
            (prompt, Jsonb(options), correct_option, sort_order, question_id),
        ).fetchone()
        if not result:
            raise ApiError("Quiz question not found.", 404)
        conn.execute("UPDATE quizzes SET updated_at=NOW() WHERE id=%s", (result["quiz_id"],))
    return jsonify({"ok": True})


@app.delete("/api/admin/quiz-questions/<int:question_id>")
@require_admin
def api_admin_delete_quiz_question(question_id):
    with database_connection() as conn:
        result = conn.execute("DELETE FROM quiz_questions WHERE id=%s RETURNING quiz_id", (question_id,)).fetchone()
        if not result:
            raise ApiError("Quiz question not found.", 404)
        conn.execute("UPDATE quizzes SET updated_at=NOW() WHERE id=%s", (result["quiz_id"],))
    return jsonify({"ok": True})


def student_quiz_access(conn, course_id, user_id):
    enrollment = conn.execute(
        "SELECT completion_status FROM enrollments WHERE user_id=%s AND course_id=%s AND status='active'",
        (user_id, course_id),
    ).fetchone()
    if not enrollment:
        raise ApiError("Enroll in this course first.", 403)
    if enrollment["completion_status"] != "approved":
        raise ApiError("Finish all topics and wait for admin completion approval before taking the quiz.", 403)
    quiz = conn.execute(
        "SELECT id,title,pass_percentage FROM quizzes WHERE course_id=%s AND published=TRUE",
        (course_id,),
    ).fetchone()
    if not quiz:
        raise ApiError("The admin has not published this course quiz yet.", 404)
    questions = conn.execute(
        "SELECT id,prompt,options,correct_option,sort_order FROM quiz_questions WHERE quiz_id=%s ORDER BY sort_order,id",
        (quiz["id"],),
    ).fetchall()
    if not questions:
        raise ApiError("This quiz does not have any questions yet.", 404)
    return quiz, questions


@app.get("/api/courses/<int:course_id>/quiz")
@require_login
def api_student_quiz(course_id):
    with database_connection() as conn:
        quiz, questions = student_quiz_access(conn, course_id, request.user["id"])
        best = conn.execute(
            "SELECT score,passed,created_at FROM quiz_attempts WHERE user_id=%s AND course_id=%s ORDER BY score DESC,created_at DESC LIMIT 1",
            (request.user["id"], course_id),
        ).fetchone()
        certificate = conn.execute(
            """SELECT cert.certificate_code::text AS certificate_code,cert.issued_at,qa.score,
                      qa.correct_count,qa.question_count
               FROM certificates cert JOIN quiz_attempts qa ON qa.id=cert.quiz_attempt_id
               WHERE cert.user_id=%s AND cert.course_id=%s""",
            (request.user["id"], course_id),
        ).fetchone()
    # Never return the answer key to the browser; the submit endpoint needs it
    # server-side to grade the learner's selected options.
    student_questions = [
        {key: question[key] for key in ("id", "prompt", "options", "sort_order")}
        for question in questions
    ]
    return jsonify({"quiz": quiz, "questions": student_questions, "best_attempt": best, "certificate": certificate})


@app.post("/api/courses/<int:course_id>/quiz/submit")
@require_login
def api_student_submit_quiz(course_id):
    raw_answers = read_json().get("answers")
    if not isinstance(raw_answers, dict):
        raise ApiError("Select an answer for each quiz question.")
    with database_connection() as conn:
        quiz, questions = student_quiz_access(conn, course_id, request.user["id"])
        question_ids = {int(question["id"]) for question in questions}
        try:
            answers = {int(question_id): int(option) for question_id, option in raw_answers.items()}
        except (TypeError, ValueError) as exc:
            raise ApiError("One or more quiz answers are invalid.") from exc
        if set(answers) != question_ids:
            raise ApiError("Answer every question before submitting your quiz.")
        for question in questions:
            option = answers[int(question["id"])]
            if option < 0 or option >= len(question["options"]):
                raise ApiError("One or more selected answer choices are invalid.")
        correct = sum(1 for question in questions if answers[int(question["id"])] == question["correct_option"])
        score = (Decimal(correct) * Decimal("100") / Decimal(len(questions))).quantize(Decimal("0.01"))
        passed = score >= Decimal(quiz["pass_percentage"])
        attempt = conn.execute(
            """INSERT INTO quiz_attempts(user_id,course_id,score,correct_count,question_count,passed,answers)
               VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (request.user["id"], course_id, score, correct, len(questions), passed, Jsonb({str(key): value for key, value in answers.items()})),
        ).fetchone()
        certificate_code = None
        certificate_issued_at = None
        if passed:
            certificate = conn.execute(
                """INSERT INTO certificates(certificate_code,user_id,course_id,quiz_attempt_id)
                   VALUES(%s,%s,%s,%s) ON CONFLICT(user_id,course_id) DO NOTHING
                   RETURNING certificate_code::text AS certificate_code,issued_at""",
                (uuid.uuid4(), request.user["id"], course_id, attempt["id"]),
            ).fetchone()
            if not certificate:
                certificate = conn.execute(
                    "SELECT certificate_code::text AS certificate_code,issued_at FROM certificates WHERE user_id=%s AND course_id=%s",
                    (request.user["id"], course_id),
                ).fetchone()
            certificate_code = certificate["certificate_code"]
            certificate_issued_at = certificate["issued_at"]
    return jsonify({"score": float(score), "correct_count": correct, "question_count": len(questions), "passed": passed, "pass_percentage": float(quiz["pass_percentage"]), "certificate_code": certificate_code, "issued_at": certificate_issued_at})


def certificate_details(conn, certificate_code):
    return conn.execute(
        """SELECT cert.certificate_code::text AS certificate_code,cert.issued_at,u.name AS student_name,
                  c.title AS course_title,qa.score,qa.correct_count,qa.question_count
           FROM certificates cert JOIN users u ON u.id=cert.user_id JOIN courses c ON c.id=cert.course_id
           JOIN quiz_attempts qa ON qa.id=cert.quiz_attempt_id WHERE cert.certificate_code=%s""",
        (certificate_code,),
    ).fetchone()


@app.get("/verify/<uuid:certificate_code>")
def verify_certificate_page(certificate_code):
    with database_connection() as conn:
        certificate = certificate_details(conn, certificate_code)
    return render_template("verify.html", certificate=certificate)


@app.get("/api/certificates/<uuid:certificate_code>/download")
@require_login
def download_certificate(certificate_code):
    with database_connection() as conn:
        certificate = conn.execute(
            """SELECT cert.certificate_code::text AS certificate_code,cert.user_id,cert.issued_at,u.name AS student_name,
                      c.title AS course_title,qa.score
               FROM certificates cert JOIN users u ON u.id=cert.user_id JOIN courses c ON c.id=cert.course_id
               JOIN quiz_attempts qa ON qa.id=cert.quiz_attempt_id WHERE cert.certificate_code=%s""",
            (certificate_code,),
        ).fetchone()
        if not certificate:
            raise ApiError("Certificate not found.", 404)
        if certificate["user_id"] != request.user["id"] and request.user["role"] != "admin":
            raise ApiError("You cannot download another student's certificate.", 403)
    verify_url = url_for(
        "verify_certificate_page",
        certificate_code=certificate_code,
        _external=True,
        _scheme="https" if app.config["SESSION_COOKIE_SECURE"] else request.scheme,
    )
    buffer = io.BytesIO()
    page_width, page_height = landscape(A4)
    pdf = canvas.Canvas(buffer, pagesize=landscape(A4), pageCompression=1)
    pdf.setTitle(f"Certificate - {certificate['course_title']}")
    pdf.setFillColor(HexColor("#f5f8fc")); pdf.rect(0, 0, page_width, page_height, fill=1, stroke=0)
    pdf.setStrokeColor(HexColor("#c4d3ec")); pdf.setLineWidth(2); pdf.roundRect(25, 25, page_width - 50, page_height - 50, 12, fill=0, stroke=1)
    pdf.setStrokeColor(HexColor("#e3bb69")); pdf.setLineWidth(0.8); pdf.roundRect(34, 34, page_width - 68, page_height - 68, 9, fill=0, stroke=1)
    pdf.setStrokeColor(HexColor("#3869e8")); pdf.setLineWidth(5); pdf.line(52, page_height - 58, page_width - 52, page_height - 58)
    icon_x, icon_y = page_width / 2 - 20, page_height - 113
    pdf.setFillColor(HexColor("#3869e8")); pdf.roundRect(icon_x, icon_y, 40, 40, 9, fill=1, stroke=0)
    pdf.setStrokeColor(white); pdf.setLineWidth(1.8)
    pdf.line(icon_x + 9, icon_y + 29, icon_x + 19, icon_y + 31); pdf.line(icon_x + 19, icon_y + 31, icon_x + 19, icon_y + 10)
    pdf.line(icon_x + 19, icon_y + 31, icon_x + 31, icon_y + 29); pdf.line(icon_x + 9, icon_y + 29, icon_x + 9, icon_y + 11)
    pdf.line(icon_x + 9, icon_y + 11, icon_x + 19, icon_y + 13); pdf.line(icon_x + 19, icon_y + 13, icon_x + 31, icon_y + 11); pdf.line(icon_x + 31, icon_y + 11, icon_x + 31, icon_y + 29)
    pdf.setFillColor(HexColor("#172c4d")); pdf.setFont("Helvetica-Bold", 17); pdf.drawCentredString(page_width / 2, page_height - 135, "DIGI LEARNER")
    pdf.setFillColor(HexColor("#6b7d99")); pdf.setFont("Helvetica", 11); pdf.drawCentredString(page_width / 2, page_height - 154, "CERTIFICATE OF COURSE COMPLETION")
    pdf.setFillColor(HexColor("#172c4d")); pdf.setFont("Helvetica", 13); pdf.drawCentredString(page_width / 2, page_height - 190, "This certificate is proudly presented to")
    student_name = str(certificate["student_name"]).strip()[:100]
    name_size = 29
    name_width = page_width - 170
    while name_size > 16 and stringWidth(student_name, "Helvetica-Bold", name_size) > name_width:
        name_size -= 1
    while student_name and stringWidth(student_name, "Helvetica-Bold", name_size) > name_width:
        student_name = student_name[:-1]
    pdf.setFillColor(HexColor("#315fc9")); pdf.setFont("Helvetica-Bold", name_size); pdf.drawCentredString(page_width / 2, page_height - 232, student_name)
    pdf.setStrokeColor(HexColor("#b9c7dc")); pdf.setLineWidth(1); pdf.line(150, page_height - 246, page_width - 150, page_height - 246)
    pdf.setFillColor(HexColor("#44546a")); pdf.setFont("Helvetica", 13); pdf.drawCentredString(page_width / 2, page_height - 278, "for successfully completing")
    course_title = str(certificate["course_title"]).strip()[:140]
    course_size = 20
    course_width = page_width - 190
    while course_size > 14 and stringWidth(course_title, "Helvetica-Bold", course_size) > course_width:
        course_size -= 1
    while course_title and stringWidth(course_title, "Helvetica-Bold", course_size) > course_width:
        course_title = course_title[:-1]
    pdf.setFillColor(HexColor("#172c4d")); pdf.setFont("Helvetica-Bold", course_size); pdf.drawCentredString(page_width / 2, page_height - 309, course_title)
    pdf.setFillColor(HexColor("#53647c")); pdf.setFont("Helvetica", 11); pdf.drawCentredString(page_width / 2, page_height - 335, f"and passing the course assessment with a score of {float(certificate['score']):.0f}%.")
    issued = certificate["issued_at"].strftime("%B %d, %Y")
    pdf.setFont("Helvetica", 10); pdf.drawCentredString(page_width / 2, 91, f"Issued {issued}  ·  Certificate ID {certificate['certificate_code']}")
    pdf.setFont("Helvetica-Bold", 11); pdf.drawCentredString(page_width / 2, 66, "Digi Learner Academic Team")
    qr = QrCodeWidget(verify_url)
    qr_bounds = qr.getBounds()
    qr_size = 76
    qr_drawing = Drawing(qr_size, qr_size, transform=[qr_size / (qr_bounds[2] - qr_bounds[0]), 0, 0, qr_size / (qr_bounds[3] - qr_bounds[1]), 0, 0])
    qr_drawing.add(qr)
    renderPDF.draw(qr_drawing, pdf, page_width - 124, 51)
    pdf.setFillColor(HexColor("#697992")); pdf.setFont("Helvetica", 7); pdf.drawCentredString(page_width - 86, 39, "Scan to verify")
    pdf.save()
    buffer.seek(0)
    response = make_response(send_file(buffer, as_attachment=True, download_name=f"Digi-Learner-Certificate-{certificate['certificate_code'][:8]}.pdf", mimetype="application/pdf"))
    response.headers["Cache-Control"] = "private, no-store"
    return response


IMPORT_COLUMNS = ["CourseCode", "CourseTitle", "CourseDescription", "ImageURL", "CourseVideoURL", "Paid", "Price", "Published", "TopicTitle", "TopicDescription", "VideoURL", "ResourceURL", "SortOrder"]


def bool_value(value, default=False):
    if value is None or str(value).strip() == "":
        return default
    return str(value).strip().lower() in {"true", "yes", "1", "y", "paid"}


@app.post("/api/admin/import")
@require_admin
def api_admin_import():
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename.lower().endswith(".xlsx"):
        raise ApiError("Choose an .xlsx Excel file.")
    try:
        workbook = load_workbook(io.BytesIO(uploaded.read()), read_only=True, data_only=True)
    except Exception as exc:
        raise ApiError("This Excel file could not be opened.") from exc
    sheet = workbook["CourseUpload"] if "CourseUpload" in workbook.sheetnames else workbook.active
    rows = sheet.iter_rows(values_only=True)
    try:
        headers = [str(v or "").strip().lower() for v in next(rows)]
    except StopIteration as exc:
        raise ApiError("The workbook is empty.") from exc
    required = {"coursecode", "coursetitle"}
    if not required.issubset(set(headers)):
        raise ApiError("Excel needs CourseCode and CourseTitle columns. Use the supplied template.")
    results = []
    processed = 0
    with database_connection() as conn:
        for row_number, values in enumerate(rows, start=2):
            if not any(value is not None and str(value).strip() for value in values):
                continue
            data = {headers[i]: (values[i] if i < len(values) else None) for i in range(len(headers))}
            code = str(data.get("coursecode") or "").strip().upper()
            title = str(data.get("coursetitle") or "").strip()
            try:
                if not code or not title:
                    raise ValueError("CourseCode and CourseTitle are required on each used row.")
                price = Decimal(str(data.get("price") or "0"))
                if not price.is_finite() or price < 0:
                    raise ValueError("Price must be zero or a positive number.")
                paid = bool_value(data.get("paid"), False)
                published = bool_value(data.get("published"), False)
                sort_order = int(data.get("sortorder") or 1)
                with conn.transaction():
                    course = conn.execute(
                        """INSERT INTO courses (code,title,description,image_url,course_video_url,is_paid,price,published)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (code) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description,
                           image_url=EXCLUDED.image_url, course_video_url=EXCLUDED.course_video_url,
                           is_paid=EXCLUDED.is_paid, price=EXCLUDED.price, published=EXCLUDED.published, updated_at=NOW()
                           RETURNING id""",
                        (code, title, str(data.get("coursedescription") or ""), str(data.get("imageurl") or ""),
                         str(data.get("coursevideourl") or ""), paid, price if paid else Decimal("0"), published),
                    ).fetchone()
                    topic_title = str(data.get("topictitle") or "").strip()
                    if topic_title:
                        found = conn.execute(
                            "SELECT id FROM topics WHERE course_id=%s AND LOWER(title)=LOWER(%s) ORDER BY id LIMIT 1",
                            (course["id"], topic_title),
                        ).fetchone()
                        if found:
                            conn.execute(
                                "UPDATE topics SET description=%s, video_url=%s, resource_url=%s, sort_order=%s WHERE id=%s",
                                (str(data.get("topicdescription") or ""), str(data.get("videourl") or ""), str(data.get("resourceurl") or ""), sort_order, found["id"]),
                            )
                        else:
                            conn.execute(
                                """INSERT INTO topics(course_id,title,description,video_url,resource_url,sort_order)
                                   VALUES(%s,%s,%s,%s,%s,%s)""",
                                (course["id"], topic_title, str(data.get("topicdescription") or ""), str(data.get("videourl") or ""), str(data.get("resourceurl") or ""), sort_order),
                            )
                processed += 1
                results.append({"row": row_number, "ok": True, "message": f"Imported {code} / {title}" + (f" / {topic_title}" if topic_title else "")})
            except Exception as exc:
                results.append({"row": row_number, "ok": False, "message": str(exc)[:300]})
    workbook.close()
    return jsonify({"processed": processed, "failed": sum(1 for r in results if not r["ok"]), "results": results})


@app.get("/api/admin/import-template.xlsx")
@require_admin
def api_admin_import_template():
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "CourseUpload"
    sheet.append(IMPORT_COLUMNS)
    sheet.append(["PY-101", "Python Programming", "Python fundamentals", "", "", "False", 0, "True", "Getting Started", "Install Python and run your first program.", "", "", 1])
    sheet.freeze_panes = "A2"
    for column in sheet.columns:
        letter = column[0].column_letter
        sheet.column_dimensions[letter].width = min(max(max(len(str(c.value or "")) for c in column) + 2, 14), 34)
    output = io.BytesIO()
    workbook.save(output)
    output.seek(0)
    return send_file(output, as_attachment=True, download_name="course-upload-template.xlsx", mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.get("/api/admin/export.csv")
@require_admin
def api_admin_export_csv():
    with database_connection() as conn:
        rows = conn.execute(
            """SELECT c.code,c.title,c.description,c.image_url,c.course_video_url,c.is_paid,c.price,c.published,
                      t.title AS topic_title,t.description AS topic_description,t.video_url,t.resource_url,t.sort_order
               FROM courses c LEFT JOIN topics t ON t.course_id=c.id ORDER BY c.code,t.sort_order"""
        ).fetchall()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(IMPORT_COLUMNS)
    for row in rows:
        writer.writerow([row["code"],row["title"],row["description"],row["image_url"],row["course_video_url"],row["is_paid"],row["price"],row["published"],row["topic_title"] or "",row["topic_description"] or "",row["video_url"] or "",row["resource_url"] or "",row["sort_order"] or 1])
    return app.response_class(output.getvalue(), mimetype="text/csv", headers={"Content-Disposition": "attachment; filename=courses-export.csv"})


@app.errorhandler(Exception)
def handle_unexpected_error(exc):
    if isinstance(exc, (KeyboardInterrupt, SystemExit)):
        raise exc
    if isinstance(exc, HTTPException):
        if request.path.startswith("/api/"):
            return jsonify({"error": exc.description}), exc.code
        return exc
    app.logger.exception("Unexpected application error")
    if request.path.startswith("/api/"):
        return jsonify({"error": "Something went wrong. Please try again."}), 500
    return "Something went wrong. Please try again.", 500


if DATABASE_URL:
    try:
        DATABASE_POOL.open(wait=False)
        create_schema()
    except Exception:
        app.logger.exception("Database initialization failed; check DATABASE_URL and database availability")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=False)
