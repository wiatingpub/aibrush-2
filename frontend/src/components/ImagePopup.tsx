import React, { FC, useEffect, useRef, useState } from "react";
import { Modal } from "react-bootstrap";
import { CreateImageInput, Image, StatusEnum } from "../client/api";
import { LocalImage } from "../lib/localImagesStore";
import { getUpscaleLevel } from "../lib/upscale";

interface ImagePopupProps {
    assetsUrl: string;
    image: LocalImage;
    censorNSFW: boolean;
    onClose: () => void;
    onDelete?: (image: LocalImage) => void;
    onFork?: (image: LocalImage) => void;
    onEdit?: (image: LocalImage) => void;
    onNSFW?: (image: LocalImage, nsfw: boolean) => void;
    onSave?: (image: LocalImage) => void;
}

export const ImagePopup: FC<ImagePopupProps> = ({
    assetsUrl,
    image,
    censorNSFW,
    onClose,
    onDelete,
    onFork,
    onEdit,
    onNSFW,
    onSave,
}) => {
    const img = useRef<HTMLImageElement>(null);
    let src = `${assetsUrl}/${image.id}.image.png?updated_at=${image.updated_at}`;
    if (image.imageData) {
        src = image.imageData;
    }
    let score = image.score;
    if (
        image.params.negative_prompt &&
        image.negative_score != 0
    ) {
        score -= image.negative_score;
    }
    const [showNSFW, setShowNSFW] = useState(false);

    const statusBadge = (status: string) => {
        const displayStatus = status.charAt(0).toUpperCase() + status.slice(1);
        let icon = "fa fa-question-circle";
        switch (status) {
            case StatusEnum.Pending:
                icon = "fas fa-hourglass-half";
                break;
            case StatusEnum.Processing:
                icon = "fas fa-cog fa-spin";
                break;
            case StatusEnum.Completed:
                icon = "fas fa-check";
                break;
            case StatusEnum.Saved:
                icon = "fas fa-save";
                break;
            case StatusEnum.Error:
                icon = "fas fa-exclamation-circle";
                break;
        }
        return (
            <>
                <span style={{ fontSize: "24px" }}>
                    <i
                        className={`${icon} status-badge status-badge-${status}`}
                        style={{
                            fontSize: "10px",
                            position: "relative",
                            top: "-1px",
                        }}
                    ></i>
                    &nbsp;{displayStatus}
                </span>
            </>
        );
    };

    useEffect(() => {
        if (!img.current) {
            return;
        }
        img.current.onerror = () => {
            if (!img.current) {
                return;
            }
            img.current.src = "/images/default.png";
        };
    }, [img]);

    let title = image.label;
    if (!title) {
        title = image.params.prompt!;
    }

    // if open, show modal with image
    return (
        <Modal show={true} onHide={onClose} size="xl">
            <Modal.Header closeButton>
                <Modal.Title>{title}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <img
                    ref={img}
                    style={{
                        maxWidth: "100%",
                        maxHeight: "1024px",
                        display: "block",
                        marginLeft: "auto",
                        marginRight: "auto",
                        filter: (image.nsfw && censorNSFW) && !showNSFW ? "blur(30px)" : "",
                    }}
                    id={`image-popup-${image.id}`}
                    src={src}
                    alt={image.label}
                />
                {/* List these fields: status, iterations, phrases */}
                <div className="row">
                    <div className="col-lg-12"></div>
                </div>
                {/* controls */}
                <div className="row">
                    <div className="col-lg-12">
                        <div
                            className="image-popup-controls"
                            style={{ marginTop: "40px" }}
                        >
                            {statusBadge(image.status)}
                            <div style={{ float: "right" }}>
                                {onFork &&
                                    (image.status === StatusEnum.Saved ||
                                        image.status ===
                                            StatusEnum.Completed) && (
                                        <button
                                            className="btn btn-secondary btn-sm image-popup-button"
                                            onClick={() => onFork(image)}
                                            style={{ marginRight: "5px" }}
                                        >
                                            <i className="fas fa-code-branch"></i>
                                            &nbsp;VARIATIONS
                                        </button>
                                    )}
                                {onDelete && (
                                    <button
                                        className="btn btn-danger btn-sm image-popup-delete-button"
                                        onClick={() =>
                                            onDelete && onDelete(image)
                                        }
                                        style={{ marginRight: "5px" }}
                                    >
                                        <i className="fas fa-trash-alt"></i>
                                        &nbsp;DELETE
                                    </button>
                                )}
                                {onEdit && (
                                    <button
                                        className="btn btn-primary btn-sm image-popup-button edit-button"
                                        onClick={() => onEdit && onEdit(image)}
                                        style={{ marginRight: "5px" }}
                                    >
                                        <i className="fas fa-edit"></i>
                                        &nbsp;EDIT
                                    </button>
                                )}
                                {onSave && (
                                    <button
                                        className="btn btn-primary btn-sm image-popup-button"
                                        onClick={() => onSave && onSave(image)}
                                        style={{ marginRight: "5px" }}
                                    >
                                        <i className="fas fa-save"></i>
                                        &nbsp;SAVE
                                    </button>
                                )}
                                {(image.nsfw && censorNSFW) && (
                                    <button
                                        className="btn btn-primary btn-sm image-popup-button"
                                        onClick={() => setShowNSFW(!showNSFW)}
                                        style={{ marginRight: "5px" }}
                                    >
                                        <i className="fas fa-eye"></i>
                                        &nbsp;{showNSFW ? "HIDE" : "SHOW"}
                                    </button>
                                )}
                            </div>
                        </div>
                        <div
                            className="image-popup-controls"
                            style={{ marginTop: "28px", marginBottom: "85px" }}
                        >
                            {/* Horde interface doesn't support score yet */}
                            {/* <div>
                                Similarity to prompt: {(score * 200).toFixed(2)}
                                %
                            </div> */}
                            <div>
                                Image dimensions: {image.params.width} x {image.params.height}
                            </div>
                            <div>
                                Model: {image.model}
                            </div>
                            {image.nsfw && (
                                <>
                                    <div>
                                        {/* alert warning icon */}
                                        <i
                                            className="fas fa-exclamation-triangle"
                                            style={{
                                                color: "orange",
                                                fontSize: "18px",
                                                position: "relative",
                                                top: "2px",
                                            }}
                                        ></i>
                                        &nbsp;May contain NSFW content
                                    </div>
                                    {onNSFW && (
                                        <a
                                            href="javascript:void(0)"
                                            onClick={() =>
                                                onNSFW(image, false)
                                            }
                                        >
                                            Mark as Safe for Work
                                        </a>
                                    )}
                                </>
                            )}
                            {!image.nsfw && (
                                <>
                                    <div>
                                        {/* green check icon */}
                                        <i
                                            className="fas fa-check"
                                            style={{
                                                color: "green",
                                                fontSize: "18px",
                                                position: "relative",
                                                top: "2px",
                                            }}
                                        ></i>
                                        &nbsp;Safe for Work
                                    </div>
                                    {onNSFW && (
                                        <a
                                            href="javascript:void(0)"
                                            onClick={() =>
                                                onNSFW(image, true)
                                            }
                                        >
                                            Mark as Not Safe for Work
                                        </a>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </Modal.Body>
        </Modal>
    );
};
