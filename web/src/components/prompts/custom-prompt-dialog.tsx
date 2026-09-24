import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { App, Button, Form, Input, Modal } from "antd";
import { Plus, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readFileAsDataUrl } from "@/lib/image-utils";
import type { Prompt } from "@/services/api/prompts";
import { useCustomPromptsStore, type NewCustomPrompt } from "@/stores/use-custom-prompts-store";

type Mode = "add" | "edit";

type Props = {
    open: boolean;
    mode: Mode;
    initial?: Prompt | null;
    onClose: () => void;
    onSaved?: () => void;
};

type CustomPromptFormValues = Omit<NewCustomPrompt, "tags" | "coverUrl" | "referenceImageUrls"> & {
    tags?: string;
};

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export function CustomPromptDialog({ open, mode, initial, onClose, onSaved }: Props) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const addPrompt = useCustomPromptsStore((state) => state.addPrompt);
    const updatePrompt = useCustomPromptsStore((state) => state.updatePrompt);
    const [form] = Form.useForm<CustomPromptFormValues>();
    const [submitting, setSubmitting] = useState(false);
    const [coverUrl, setCoverUrl] = useState("");
    const [referenceUrls, setReferenceUrls] = useState<string[]>([]);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const referencesInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        if (mode === "edit" && initial) {
            form.setFieldsValue({
                title: initial.title,
                prompt: initial.prompt,
                description: initial.description,
                tags: initial.tags.join(", "),
            });
            setCoverUrl(initial.coverUrl || "");
            setReferenceUrls(Array.isArray(initial.referenceImageUrls) ? initial.referenceImageUrls : []);
        } else {
            form.resetFields();
            setCoverUrl("");
            setReferenceUrls([]);
        }
    }, [open, mode, initial, form]);

    const validateImageFile = (file: File): boolean => {
        if (!file.type.startsWith("image/")) {
            message.error(t("prompts.custom.notImage"));
            return false;
        }
        if (file.size > MAX_FILE_SIZE) {
            message.error(t("prompts.custom.fileTooLarge", { size: "5MB" }));
            return false;
        }
        return true;
    };

    const handleCoverSelect = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file || !validateImageFile(file)) return;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            setCoverUrl(dataUrl);
        } catch {
            message.error(t("prompts.custom.imageReadFailed"));
        }
    };

    const handleReferencesSelect = async (event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        event.target.value = "";
        if (!files.length) return;
        const valid = files.filter(validateImageFile);
        if (!valid.length) return;
        try {
            const dataUrls = await Promise.all(valid.map((file) => readFileAsDataUrl(file)));
            setReferenceUrls((prev) => [...prev, ...dataUrls]);
        } catch {
            message.error(t("prompts.custom.imageReadFailed"));
        }
    };

    const removeReference = (index: number) => {
        setReferenceUrls((prev) => prev.filter((_, i) => i !== index));
    };

    const handleOk = async () => {
        try {
            const values = await form.validateFields();
            const payload: NewCustomPrompt = {
                title: values.title,
                prompt: values.prompt,
                description: values.description,
                tags: values.tags?.split(","),
                coverUrl,
                referenceImageUrls: referenceUrls,
            };
            setSubmitting(true);
            const saved = mode === "edit" && initial ? await updatePrompt(initial.id, payload) : await addPrompt(payload);
            if (!saved) {
                message.error(t("prompts.custom.saveFailed"));
                return;
            }
            message.success(mode === "edit" ? t("prompts.custom.updated") : t("prompts.custom.added"));
            onSaved?.();
            onClose();
        } catch (error) {
            if (error instanceof Error) message.error(t("prompts.custom.saveFailed"));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal
            title={mode === "edit" ? t("prompts.custom.editTitle") : t("prompts.custom.addTitle")}
            open={open}
            onCancel={onClose}
            onOk={() => void handleOk()}
            okText={t("common.save")}
            cancelText={t("common.cancel")}
            confirmLoading={submitting}
            destroyOnHidden
            forceRender
            width={600}
        >
            <Form form={form} layout="vertical" preserve={false}>
                <Form.Item label={t("prompts.custom.form.title")} name="title" rules={[{ required: true, whitespace: true, message: t("prompts.custom.form.titleRequired") }]}>
                    <Input maxLength={80} showCount placeholder={t("prompts.custom.form.titlePlaceholder")} />
                </Form.Item>
                <Form.Item label={t("prompts.custom.form.prompt")} name="prompt" rules={[{ required: true, whitespace: true, message: t("prompts.custom.form.promptRequired") }]}>
                    <Input.TextArea rows={6} placeholder={t("prompts.custom.form.promptPlaceholder")} />
                </Form.Item>
                <Form.Item label={t("prompts.custom.form.description")} name="description">
                    <Input.TextArea rows={2} placeholder={t("prompts.custom.form.descriptionPlaceholder")} />
                </Form.Item>
                <Form.Item label={t("prompts.custom.form.tags")} name="tags">
                    <Input placeholder={t("prompts.custom.form.tagsPlaceholder")} />
                </Form.Item>
                <Form.Item label={t("prompts.custom.form.cover")}>
                    <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={handleCoverSelect} />
                    {coverUrl ? (
                        <div className="relative inline-block">
                            <img src={coverUrl} alt="" className="h-24 w-24 rounded-md border border-stone-200 object-cover dark:border-stone-700" />
                            <Button
                                type="text"
                                size="small"
                                danger
                                icon={<X className="size-3.5" />}
                                className="!absolute !-right-2 !-top-2 !h-6 !w-6 !min-w-0 !rounded-full !border !border-stone-200 !bg-white !p-0 dark:!border-stone-700 dark:!bg-stone-900"
                                onClick={() => setCoverUrl("")}
                            />
                        </div>
                    ) : (
                        <Button icon={<Upload className="size-4" />} onClick={() => coverInputRef.current?.click()}>
                            {t("prompts.custom.form.coverUpload")}
                        </Button>
                    )}
                </Form.Item>
                <Form.Item label={t("prompts.custom.form.references")}>
                    <input ref={referencesInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleReferencesSelect} />
                    <div className="flex flex-wrap gap-2">
                        {referenceUrls.map((url, index) => (
                            <div key={`${index}-${url.slice(0, 24)}`} className="relative">
                                <img src={url} alt="" className="h-20 w-20 rounded-md border border-stone-200 object-cover dark:border-stone-700" />
                                <Button
                                    type="text"
                                    size="small"
                                    danger
                                    icon={<X className="size-3.5" />}
                                    className="!absolute !-right-2 !-top-2 !h-6 !w-6 !min-w-0 !rounded-full !border !border-stone-200 !bg-white !p-0 dark:!border-stone-700 dark:!bg-stone-900"
                                    onClick={() => removeReference(index)}
                                />
                            </div>
                        ))}
                        <Button type="dashed" icon={<Plus className="size-4" />} className="!h-20 !w-20 !flex-col" onClick={() => referencesInputRef.current?.click()}>
                            {t("prompts.custom.form.referencesAdd")}
                        </Button>
                    </div>
                </Form.Item>
            </Form>
        </Modal>
    );
}
