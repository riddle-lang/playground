use lsp_types::{InlayHintLabel, Position, Range};
use riddlec::pipeline::{
    CompileOptions, CompileResult, check_with_options, compile_with_options, generate_c,
};
use serde::Serialize;
use type_checker::{LabelStyle, Severity};
use wasm_bindgen::prelude::*;

// Compile the browser-safe analysis half of the checked-out riddle-lsp source.
// Its stdio server depends on Tokio features that wasm32 cannot provide.
#[allow(dead_code)]
trait UrlFilePath {
    fn to_file_path(&self) -> Result<std::path::PathBuf, ()>;
}

impl UrlFilePath for lsp_types::Url {
    fn to_file_path(&self) -> Result<std::path::PathBuf, ()> {
        (self.scheme() == "file")
            .then(|| std::path::PathBuf::from(self.path()))
            .ok_or(())
    }
}

#[allow(dead_code)]
mod analysis {
    use crate::UrlFilePath as _;
    include!("../../riddle-src/app/riddle-lsp/src/analysis.rs");
}

#[allow(dead_code)]
mod completion {
    use crate::UrlFilePath as _;
    include!("../../riddle-src/app/riddle-lsp/src/completion.rs");
}
#[path = "../../riddle-src/app/riddle-lsp/src/inlay_hints.rs"]
#[allow(dead_code)]
mod inlay_hints;
#[path = "../../riddle-src/app/riddle-lsp/src/semantic_tokens.rs"]
#[allow(dead_code)]
mod semantic_tokens;
#[allow(dead_code)]
mod session {
    use crate::UrlFilePath as _;
    include!("../../riddle-src/app/riddle-lsp/src/session.rs");
}
#[path = "../../riddle-src/app/riddle-lsp/src/text.rs"]
#[allow(dead_code)]
mod text;

#[allow(dead_code)]
mod server {
    #[derive(Debug, Clone)]
    pub struct Document {
        pub text: String,
        pub version: Option<i32>,
    }
}

mod diagnostics {
    pub(crate) fn position(source: &str, offset: usize) -> lsp_types::Position {
        let offset = offset.min(source.len());
        let before = &source[..offset];
        let line = before.bytes().filter(|byte| *byte == b'\n').count() as u32;
        let line_start = before.rfind('\n').map_or(0, |index| index + 1);
        let character = source[line_start..offset]
            .chars()
            .map(char::len_utf16)
            .sum::<usize>() as u32;
        lsp_types::Position::new(line, character)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: String,
    pub message: String,
    pub start: u32,
    pub end: u32,
    pub start_line: u32,
    pub start_character: u32,
    pub end_line: u32,
    pub end_character: u32,
    pub code: Option<String>,
}

#[derive(Serialize)]
pub struct CompileOutput {
    pub success: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub c_source: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SemanticToken {
    delta_line: u32,
    delta_start: u32,
    length: u32,
    token_type: u32,
    token_modifiers_bitset: u32,
}

#[derive(Serialize)]
struct InlayHint {
    line: u32,
    character: u32,
    label: String,
}

fn severity_str(severity: Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Note => "note",
        Severity::Help => "help",
    }
}

fn primary_range(diagnostic: &type_checker::Diagnostic) -> (u32, u32) {
    diagnostic
        .labels
        .iter()
        .find(|label| label.style == LabelStyle::Primary)
        .or_else(|| diagnostic.labels.first())
        .map(|label| (u32::from(label.range.start()), u32::from(label.range.end())))
        .unwrap_or((0, 0))
}

fn diagnostic(
    source: &str,
    severity: &str,
    message: String,
    start: u32,
    end: u32,
    code: Option<String>,
) -> Diagnostic {
    let position = |offset: u32| {
        let mut byte_offset = (offset as usize).min(source.len());
        while !source.is_char_boundary(byte_offset) {
            byte_offset -= 1;
        }
        let position = diagnostics::position(source, byte_offset);
        (
            source[..byte_offset].encode_utf16().count() as u32,
            position,
        )
    };
    let (start, start_position) = position(start);
    let (end, end_position) = position(end);
    Diagnostic {
        severity: severity.into(),
        message,
        start,
        end,
        start_line: start_position.line,
        start_character: start_position.character,
        end_line: end_position.line,
        end_character: end_position.character,
        code,
    }
}

fn collect_diagnostics(result: &CompileResult, source: &str) -> Vec<Diagnostic> {
    let mut output = result
        .parse_errors
        .iter()
        .map(|error| {
            diagnostic(
                source,
                "error",
                error.message.clone(),
                u32::from(error.span.start()),
                u32::from(error.span.end()),
                None,
            )
        })
        .collect::<Vec<_>>();
    for diagnostics in [
        &result.hir_diagnostics,
        &result.type_result.diagnostics,
        &result.analysis_diagnostics,
    ] {
        output.extend(diagnostics.iter().map(|item| {
            let (start, end) = primary_range(item);
            diagnostic(
                source,
                severity_str(item.severity),
                item.message.clone(),
                start,
                end,
                (!item.code.is_empty()).then(|| item.code.to_string()),
            )
        }));
    }
    output
}

#[wasm_bindgen]
pub fn riddle_check(source: &str) -> JsValue {
    let result = check_with_options(source, CompileOptions::default());
    serde_wasm_bindgen::to_value(&CompileOutput {
        success: result.success(),
        diagnostics: collect_diagnostics(&result, source),
        c_source: None,
    })
    .unwrap()
}

#[wasm_bindgen]
pub fn riddle_compile(source: &str) -> JsValue {
    let result = compile_with_options(source, CompileOptions::default());
    let c_source = result
        .mir_module
        .as_ref()
        .and_then(|module| generate_c(module).ok());
    serde_wasm_bindgen::to_value(&CompileOutput {
        success: result.success(),
        diagnostics: collect_diagnostics(&result, source),
        c_source,
    })
    .unwrap()
}

#[wasm_bindgen]
pub fn riddle_semantic_tokens(source: &str) -> JsValue {
    let tokens = semantic_tokens::semantic_tokens_for_source(source)
        .data
        .into_iter()
        .map(|token| SemanticToken {
            delta_line: token.delta_line,
            delta_start: token.delta_start,
            length: token.length,
            token_type: token.token_type,
            token_modifiers_bitset: token.token_modifiers_bitset,
        })
        .collect::<Vec<_>>();
    serde_wasm_bindgen::to_value(&tokens).unwrap()
}

#[wasm_bindgen]
pub fn riddle_completions(source: &str, line: u32, character: u32) -> JsValue {
    let items = completion::completion_items_for_source(
        source,
        Position::new(line, character),
        CompileOptions { use_std: false },
    );
    serde_wasm_bindgen::to_value(&items).unwrap()
}

#[wasm_bindgen]
pub fn riddle_inlay_hints(source: &str) -> JsValue {
    let hints = inlay_hints::inlay_hints_for_source(
        source,
        Range::new(Position::new(0, 0), Position::new(u32::MAX, u32::MAX)),
    )
    .into_iter()
    .map(|hint| InlayHint {
        line: hint.position.line,
        character: hint.position.character,
        label: match hint.label {
            InlayHintLabel::String(label) => label,
            InlayHintLabel::LabelParts(parts) => parts.into_iter().map(|part| part.value).collect(),
        },
    })
    .collect::<Vec<_>>();
    serde_wasm_bindgen::to_value(&hints).unwrap()
}
