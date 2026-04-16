import os
import uuid
import warnings
from datetime import datetime
from flask import (
    Flask,
    render_template,
    request,
    redirect,
    url_for,
    jsonify,
    abort,
    send_from_directory,
)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.utils import secure_filename

app = Flask(__name__)
_secret = os.environ.get("SECRET_KEY")
if not _secret:
    warnings.warn(
        "SECRET_KEY environment variable is not set. "
        "Using an insecure default — do NOT deploy this to production.",
        stacklevel=1,
    )
    _secret = "dev-secret-key-change-in-production"
app.config["SECRET_KEY"] = _secret
_db_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "instance")
os.makedirs(_db_dir, exist_ok=True)
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get(
    "DATABASE_URL", f"sqlite:///{os.path.join(_db_dir, 'annotations.db')}"
)
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["UPLOAD_FOLDER"] = os.path.join(os.path.dirname(__file__), "uploads")
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024  # 32 MB max upload

ALLOWED_EXTENSIONS = {"html", "htm"}

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

db = SQLAlchemy(app)


# ---------------------------------------------------------------------------
# Database models
# ---------------------------------------------------------------------------


class Presentation(db.Model):
    __tablename__ = "presentations"

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(255), nullable=False)
    filename = db.Column(db.String(255), nullable=False)
    uploaded_at = db.Column(db.DateTime, default=datetime.utcnow)
    is_sample = db.Column(db.Boolean, default=False)

    annotations = db.relationship(
        "Annotation", backref="presentation", lazy=True, cascade="all, delete-orphan"
    )

    def annotation_count(self):
        return len(self.annotations)

    def to_dict(self):
        return {
            "id": self.id,
            "title": self.title,
            "filename": self.filename,
            "uploaded_at": self.uploaded_at.isoformat(),
            "annotation_count": self.annotation_count(),
        }


class Annotation(db.Model):
    __tablename__ = "annotations"

    id = db.Column(db.Integer, primary_key=True)
    presentation_id = db.Column(
        db.Integer, db.ForeignKey("presentations.id"), nullable=False
    )
    selected_text = db.Column(db.Text, nullable=False)
    note = db.Column(db.Text, default="")
    color = db.Column(db.String(20), default="yellow")
    # Serialised anchor describing where in the document the highlight lives
    anchor_start_xpath = db.Column(db.Text, nullable=False)
    anchor_start_offset = db.Column(db.Integer, nullable=False, default=0)
    anchor_end_xpath = db.Column(db.Text, nullable=False)
    anchor_end_offset = db.Column(db.Integer, nullable=False, default=0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "presentation_id": self.presentation_id,
            "selected_text": self.selected_text,
            "note": self.note,
            "color": self.color,
            "anchor_start_xpath": self.anchor_start_xpath,
            "anchor_start_offset": self.anchor_start_offset,
            "anchor_end_xpath": self.anchor_end_xpath,
            "anchor_end_offset": self.anchor_end_offset,
            "created_at": self.created_at.isoformat(),
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def get_presentation_path(presentation: Presentation) -> str:
    if presentation.is_sample:
        return os.path.join(os.path.dirname(__file__), "sample", presentation.filename)
    return os.path.join(app.config["UPLOAD_FOLDER"], presentation.filename)


# ---------------------------------------------------------------------------
# Routes – general
# ---------------------------------------------------------------------------


@app.route("/")
def index():
    presentations = Presentation.query.order_by(Presentation.uploaded_at.desc()).all()
    return render_template("index.html", presentations=presentations)


@app.route("/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return redirect(url_for("index"))

    file = request.files["file"]
    title = request.form.get("title", "").strip()

    if file.filename == "":
        return redirect(url_for("index"))

    if not allowed_file(file.filename):
        return redirect(url_for("index"))

    filename = secure_filename(file.filename)
    # Make unique using UUID to avoid collisions
    base, ext = os.path.splitext(filename)
    filename = f"{base}_{uuid.uuid4().hex}{ext}"

    file.save(os.path.join(app.config["UPLOAD_FOLDER"], filename))

    if not title:
        title = base.replace("_", " ").replace("-", " ").title()

    presentation = Presentation(title=title, filename=filename)
    db.session.add(presentation)
    db.session.commit()

    return redirect(url_for("viewer", presentation_id=presentation.id))


@app.route("/delete/<int:presentation_id>", methods=["POST"])
def delete_presentation(presentation_id):
    presentation = Presentation.query.get_or_404(presentation_id)
    if not presentation.is_sample:
        path = get_presentation_path(presentation)
        if os.path.exists(path):
            os.remove(path)
    db.session.delete(presentation)
    db.session.commit()
    return redirect(url_for("index"))


# ---------------------------------------------------------------------------
# Routes – viewer
# ---------------------------------------------------------------------------


@app.route("/view/<int:presentation_id>")
def viewer(presentation_id):
    presentation = Presentation.query.get_or_404(presentation_id)
    annotations = (
        Annotation.query.filter_by(presentation_id=presentation_id)
        .order_by(Annotation.created_at)
        .all()
    )
    return render_template(
        "viewer.html",
        presentation=presentation,
        annotations=annotations,
    )


@app.route("/presentation-content/<int:presentation_id>")
def presentation_content(presentation_id):
    """Serve the raw HTML of a presentation so the viewer can embed it."""
    presentation = Presentation.query.get_or_404(presentation_id)
    path = get_presentation_path(presentation)
    if not os.path.exists(path):
        abort(404)
    directory = os.path.dirname(path)
    filename = os.path.basename(path)
    return send_from_directory(directory, filename)


# ---------------------------------------------------------------------------
# Routes – annotation API
# ---------------------------------------------------------------------------


@app.route("/api/annotations/<int:presentation_id>", methods=["GET"])
def get_annotations(presentation_id):
    Presentation.query.get_or_404(presentation_id)
    annotations = (
        Annotation.query.filter_by(presentation_id=presentation_id)
        .order_by(Annotation.created_at)
        .all()
    )
    return jsonify([a.to_dict() for a in annotations])


@app.route("/api/annotations", methods=["POST"])
def create_annotation():
    data = request.get_json()
    if not data:
        return jsonify({"error": "No JSON body"}), 400

    required = [
        "presentation_id",
        "selected_text",
        "anchor_start_xpath",
        "anchor_start_offset",
        "anchor_end_xpath",
        "anchor_end_offset",
    ]
    for field in required:
        if field not in data:
            return jsonify({"error": f"Missing field: {field}"}), 400

    Presentation.query.get_or_404(data["presentation_id"])

    annotation = Annotation(
        presentation_id=data["presentation_id"],
        selected_text=data["selected_text"],
        note=data.get("note", ""),
        color=data.get("color", "yellow"),
        anchor_start_xpath=data["anchor_start_xpath"],
        anchor_start_offset=data["anchor_start_offset"],
        anchor_end_xpath=data["anchor_end_xpath"],
        anchor_end_offset=data["anchor_end_offset"],
    )
    db.session.add(annotation)
    db.session.commit()
    return jsonify(annotation.to_dict()), 201


@app.route("/api/annotations/<int:annotation_id>", methods=["PUT"])
def update_annotation(annotation_id):
    annotation = Annotation.query.get_or_404(annotation_id)
    data = request.get_json()
    if not data:
        return jsonify({"error": "No JSON body"}), 400

    if "note" in data:
        annotation.note = data["note"]
    if "color" in data:
        annotation.color = data["color"]

    db.session.commit()
    return jsonify(annotation.to_dict())


@app.route("/api/annotations/<int:annotation_id>", methods=["DELETE"])
def delete_annotation(annotation_id):
    annotation = Annotation.query.get_or_404(annotation_id)
    db.session.delete(annotation)
    db.session.commit()
    return jsonify({"deleted": annotation_id})


# ---------------------------------------------------------------------------
# Bootstrap – ensure sample presentation exists
# ---------------------------------------------------------------------------


def seed_sample():
    """Add the bundled sample presentation if not already in the database."""
    if not Presentation.query.filter_by(is_sample=True).first():
        sample = Presentation(
            title="Sample: Introduction to Quarto",
            filename="sample_presentation.html",
            is_sample=True,
        )
        db.session.add(sample)
        db.session.commit()


with app.app_context():
    db.create_all()
    seed_sample()


if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "false").lower() in ("1", "true", "yes")
    app.run(debug=debug, host="0.0.0.0", port=5000)
