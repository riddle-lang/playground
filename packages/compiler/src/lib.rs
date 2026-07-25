use frontend::lexer::lex;
use frontend::syntax_kind::SyntaxKind;
use hir::body::{Expr, ResolvedName, Stmt};
use hir::item_tree::{HirFunction, HirTypeRef, TopLevelItem};
use riddlec::pipeline::{
    check_with_options, compile_with_options, generate_c, resolve_with_options, CompileOptions,
    CompileResult,
};
use rowan::TextRange;
use scope_graph::{DefRef, NodeId, RefOrigin, ScopeGraph};
use scope_graph::resolve::{exported_definitions, resolve_path_at_reference, visible_definitions};
use serde::Serialize;
use type_checker::{LabelStyle, Severity};
use wasm_bindgen::prelude::*;

// ============================================================================
// Shared output types
// ============================================================================

#[derive(Serialize)]
pub struct Diagnostic {
    pub severity: String,
    pub message: String,
    pub start: u32,
    pub end: u32,
    pub code: Option<String>,
}

#[derive(Serialize)]
pub struct CompileOutput {
    pub success: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub c_source: Option<String>,
}

// ============================================================================
// Compile / check
// ============================================================================

fn severity_str(s: Severity) -> &'static str {
    match s {
        Severity::Error   => "error",
        Severity::Warning => "warning",
        Severity::Note    => "note",
        Severity::Help    => "help",
    }
}

fn primary_range(d: &type_checker::Diagnostic) -> (u32, u32) {
    d.labels
        .iter()
        .find(|l| l.style == LabelStyle::Primary)
        .or_else(|| d.labels.first())
        .map(|l| (u32::from(l.range.start()), u32::from(l.range.end())))
        .unwrap_or((0, 0))
}

fn collect_diagnostics(result: &CompileResult) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for e in &result.parse_errors {
        out.push(Diagnostic {
            severity: "error".into(),
            message:  e.message.clone(),
            start:    u32::from(e.span.start()),
            end:      u32::from(e.span.end()),
            code:     None,
        });
    }
    for diag_list in [
        &result.hir_diagnostics,
        &result.type_result.diagnostics,
        &result.analysis_diagnostics,
    ] {
        for e in diag_list {
            let (start, end) = primary_range(e);
            out.push(Diagnostic {
                severity: severity_str(e.severity).into(),
                message:  e.message.clone(),
                start,
                end,
                code: if e.code.is_empty() { None } else { Some(e.code.to_string()) },
            });
        }
    }
    out
}

#[wasm_bindgen]
pub fn riddle_check(source: &str) -> JsValue {
    let result = check_with_options(source, CompileOptions::default());
    let output = CompileOutput {
        success:     result.success(),
        diagnostics: collect_diagnostics(&result),
        c_source:    None,
    };
    serde_wasm_bindgen::to_value(&output).unwrap()
}

#[wasm_bindgen]
pub fn riddle_compile(source: &str) -> JsValue {
    let result = compile_with_options(source, CompileOptions::default());
    let c_source = result.mir_module.as_ref().and_then(|m| generate_c(m).ok());
    let output = CompileOutput {
        success:     result.success(),
        diagnostics: collect_diagnostics(&result),
        c_source,
    };
    serde_wasm_bindgen::to_value(&output).unwrap()
}

// ============================================================================
// Semantic tokens — ported from riddle-lsp/src/semantic_tokens.rs
// ============================================================================

// Token type indices (must match TOKEN_TYPES in riddleExtension.ts)
const TT_KEYWORD:   u32 = 0;
const TT_COMMENT:   u32 = 1;
const TT_STRING:    u32 = 2;
const TT_NUMBER:    u32 = 3;
const TT_OPERATOR:  u32 = 4;
const TT_FUNCTION:  u32 = 5;
const TT_METHOD:    u32 = 6;
const TT_VARIABLE:  u32 = 7;
const TT_TYPE:      u32 = 8;
const TT_STRUCT:    u32 = 9;
const TT_ENUM:      u32 = 10;
const TT_INTERFACE: u32 = 11;
const TT_PROPERTY:  u32 = 12;
const TT_NAMESPACE: u32 = 13;
const TT_PARAMETER: u32 = 14;

// Modifier bits
const MOD_DECLARATION:    u32 = 1 << 0;
const MOD_MUTABLE:        u32 = 1 << 1;
const MOD_STATIC:         u32 = 1 << 2;

#[derive(Serialize)]
struct SemToken {
    start: u32,
    length: u32,
    #[serde(rename = "type")]
    token_type: u32,
    mods: u32,
}

const BUILTIN_TYPES: &[&str] = &[
    "bool", "char", "str",
    "i8", "i16", "i32", "i64", "isize",
    "u8", "u16", "u32", "u64", "usize",
    "f32", "f64",
];

fn is_keyword(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::Let | SyntaxKind::Fun | SyntaxKind::Struct | SyntaxKind::If
        | SyntaxKind::Else | SyntaxKind::While | SyntaxKind::Break | SyntaxKind::Continue
        | SyntaxKind::Return | SyntaxKind::As | SyntaxKind::SelfKw | SyntaxKind::Mod
        | SyntaxKind::Use | SyntaxKind::Mut | SyntaxKind::Pub | SyntaxKind::SuperKw
        | SyntaxKind::CrateKw | SyntaxKind::Enum | SyntaxKind::Trait | SyntaxKind::Impl
        | SyntaxKind::Match | SyntaxKind::Const | SyntaxKind::TypeKw | SyntaxKind::Extern
        | SyntaxKind::Unsafe | SyntaxKind::Safe | SyntaxKind::For | SyntaxKind::In
        | SyntaxKind::Where | SyntaxKind::True | SyntaxKind::False
    )
}

fn is_operator(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::Arrow | SyntaxKind::EqEq | SyntaxKind::BangEq | SyntaxKind::LessEq
        | SyntaxKind::GreaterEq | SyntaxKind::AmpAmp | SyntaxKind::PipePipe
        | SyntaxKind::FatArrow | SyntaxKind::PlusEq | SyntaxKind::MinusEq
        | SyntaxKind::StarEq | SyntaxKind::SlashEq | SyntaxKind::PercentEq
        | SyntaxKind::AmpEq | SyntaxKind::PipeEq | SyntaxKind::CaretEq
        | SyntaxKind::ShlEq | SyntaxKind::ShrEq | SyntaxKind::Shl | SyntaxKind::Shr
        | SyntaxKind::Plus | SyntaxKind::Minus | SyntaxKind::Star | SyntaxKind::Slash
        | SyntaxKind::Percent | SyntaxKind::Amp | SyntaxKind::Pipe | SyntaxKind::Caret
        | SyntaxKind::Less | SyntaxKind::Greater | SyntaxKind::Bang | SyntaxKind::Eq
    )
}

fn previous_significant<'a>(
    tokens: &'a [frontend::lexer::Token],
    index: usize,
) -> Option<&'a frontend::lexer::Token> {
    tokens[..index].iter().rev().find(|t| !t.kind.is_trivia())
}

fn next_significant<'a>(
    tokens: &'a [frontend::lexer::Token],
    index: usize,
) -> Option<&'a frontend::lexer::Token> {
    tokens[index + 1..].iter().find(|t| !t.kind.is_trivia())
}

fn ident_token_type(
    tokens: &[frontend::lexer::Token],
    index: usize,
    source: &str,
) -> Option<u32> {
    let text = tokens[index].text(source);
    if BUILTIN_TYPES.contains(&text) {
        return Some(TT_KEYWORD);
    }
    let prev = previous_significant(tokens, index).map(|t| t.kind);
    let next = next_significant(tokens, index).map(|t| t.kind);
    match prev {
        Some(SyntaxKind::Fun)    => Some(TT_FUNCTION),
        Some(SyntaxKind::Struct) => Some(TT_STRUCT),
        Some(SyntaxKind::Enum)   => Some(TT_ENUM),
        Some(SyntaxKind::Trait)  => Some(TT_INTERFACE),
        Some(SyntaxKind::Mod) | Some(SyntaxKind::Use) => Some(TT_NAMESPACE),
        Some(SyntaxKind::TypeKw) | Some(SyntaxKind::Impl) => Some(TT_TYPE),
        Some(SyntaxKind::Dot) => {
            if next == Some(SyntaxKind::LParen) { Some(TT_METHOD) } else { Some(TT_PROPERTY) }
        }
        _ if next == Some(SyntaxKind::LParen) => Some(TT_FUNCTION),
        _ if text.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) => Some(TT_TYPE),
        _ => None,
    }
}

fn lexer_token_type(
    tokens: &[frontend::lexer::Token],
    index: usize,
    source: &str,
) -> Option<(u32, u32)> {
    let kind = tokens[index].kind;
    let tt = match kind {
        SyntaxKind::Whitespace | SyntaxKind::ErrorNode | SyntaxKind::Eof => return None,
        SyntaxKind::LineComment => TT_COMMENT,
        SyntaxKind::String | SyntaxKind::Char => TT_STRING,
        SyntaxKind::Number | SyntaxKind::Float => TT_NUMBER,
        SyntaxKind::Ident => ident_token_type(tokens, index, source)?,
        k if is_keyword(k)  => TT_KEYWORD,
        k if is_operator(k) => TT_OPERATOR,
        _ => return None,
    };
    Some((tt, 0))
}

#[derive(Clone, Copy)]
struct RawToken {
    start: u32,
    end:   u32,
    token_type: u32,
    mods: u32,
    resolved: bool,
}

fn ranges_overlap(a: TextRange, b: TextRange) -> bool {
    a.start() < b.end() && b.start() < a.end()
}

fn range_in_source(range: TextRange, source_len: usize) -> Option<TextRange> {
    (usize::from(range.end()) <= source_len).then_some(range)
}

fn collect_hir_tokens(
    source: &str,
    result: &CompileResult,
    tokens: &[frontend::lexer::Token],
    out: &mut Vec<RawToken>,
) {
    let Some(hir) = &result.hir else { return };
    let source_len = source.len();

    let mut symbol_types: std::collections::HashMap<&str, (u32, u32)> = std::collections::HashMap::new();
    let mut method_mods: std::collections::HashMap<hir::item_tree::FunctionId, u32> = std::collections::HashMap::new();
    let mut function_mods: std::collections::HashMap<hir::item_tree::FunctionId, u32> = std::collections::HashMap::new();

    for (_, item) in hir.item_tree.structs.iter() {
        if range_in_source(item.name_range, source_len).is_some() {
            symbol_types.insert(item.name.0.as_str(), (TT_STRUCT, 0));
        }
    }
    for (_, item) in hir.item_tree.enums.iter() {
        if range_in_source(item.name_range, source_len).is_some() {
            symbol_types.insert(item.name.0.as_str(), (TT_ENUM, 0));
        }
        for variant in &item.variants {
            if range_in_source(variant.name_range, source_len).is_some() {
                symbol_types.entry(variant.name.0.as_str()).or_insert((TT_ENUM, 0));
            }
        }
    }
    for (_, item) in hir.item_tree.traits.iter() {
        symbol_types.entry(item.name.0.as_str()).or_insert((TT_INTERFACE, 0));
        for method in &item.methods {
            if let Some(r) = range_in_source(method.name_range, source_len) {
                let mut mods = MOD_DECLARATION;
                if method.params.first().is_none_or(|p| p.name.0 != "self") { mods |= MOD_STATIC; }
                out.push(RawToken { start: u32::from(r.start()), end: u32::from(r.end()), token_type: TT_METHOD, mods, resolved: true });
            }
        }
    }
    for (_, impl_item) in hir.item_tree.impls.iter() {
        for method_id in &impl_item.methods {
            let method = &hir.item_tree.functions[*method_id];
            let mut mods = 0u32;
            if method.params.first().is_none_or(|p| p.name.0 != "self") { mods |= MOD_STATIC; }
            method_mods.insert(*method_id, mods);
            if let Some(r) = range_in_source(method.name_range, source_len) {
                out.push(RawToken { start: u32::from(r.start()), end: u32::from(r.end()), token_type: TT_METHOD, mods: MOD_DECLARATION | mods, resolved: true });
            }
        }
    }
    for token in tokens {
        if let Some(&(tt, mods)) = symbol_types.get(token.text(source)) {
            out.push(RawToken { start: token.span.start as u32, end: token.span.end as u32, token_type: tt, mods, resolved: false });
        }
    }
    for (fn_id, function) in hir.item_tree.functions.iter() {
        let mods = 0u32;
        function_mods.insert(fn_id, mods);
        if !method_mods.contains_key(&fn_id) {
            if let Some(r) = range_in_source(function.name_range, source_len) {
                out.push(RawToken { start: u32::from(r.start()), end: u32::from(r.end()), token_type: TT_FUNCTION, mods: MOD_DECLARATION | mods, resolved: true });
            }
        }
        for param in &function.params {
            if param.name.0 != "self" {
                if let Some(r) = range_in_source(param.name_range, source_len) {
                    out.push(RawToken { start: u32::from(r.start()), end: u32::from(r.end()), token_type: TT_PARAMETER, mods: MOD_DECLARATION, resolved: true });
                }
            }
        }
    }
    for (_, body) in hir.bodies.iter() {
        for (_, stmt) in body.stmts.iter() {
            if let Stmt::Let { name_range: Some(range), is_mut: true, .. } = stmt {
                if let Some(r) = range_in_source(*range, source_len) {
                    out.push(RawToken { start: u32::from(r.start()), end: u32::from(r.end()), token_type: TT_VARIABLE, mods: MOD_DECLARATION | MOD_MUTABLE, resolved: true });
                }
            }
        }
        for (expr_id, expr) in body.exprs.iter() {
            if let Expr::Lambda { params, .. } = expr {
                for param in params {
                    if let Some(range) = param.name_range {
                        if let Some(r) = range_in_source(range, source_len) {
                            out.push(RawToken { start: u32::from(r.start()), end: u32::from(r.end()), token_type: TT_PARAMETER, mods: MOD_DECLARATION, resolved: true });
                        }
                    }
                }
            }
            let Expr::Path { path, resolved } = expr else { continue };
            let Some(name) = path.segments.last() else { continue };
            if path.as_single_name().is_some() && name.0 == "self" { continue; }
            let Some(range) = body.source_map.expr_ranges.get(&expr_id).copied() else { continue };
            // Get last identifier in range
            let end = usize::from(range.end());
            let range_text = source.get(usize::from(range.start())..end).unwrap_or("");
            let id_len: usize = range_text.chars().rev().take_while(|c| c.is_alphanumeric() || *c == '_').map(|c| c.len_utf8()).sum();
            if id_len == 0 { continue; }
            let id_start = end - id_len;
            if id_start > source_len || end > source_len { continue; }
            let r = TextRange::new((id_start as u32).into(), (end as u32).into());
            if range_in_source(r, source_len).is_none() { continue; }
            let (tt, mods) = match resolved.as_ref() {
                Some(ResolvedName::Local(stmt_id)) => match &body.stmts[*stmt_id] {
                    Stmt::Let { is_mut: true,  .. } => (TT_VARIABLE, MOD_MUTABLE),
                    Stmt::Let { is_mut: false, .. } => (TT_VARIABLE, 0),
                    _ => continue,
                },
                Some(ResolvedName::Param(_) | ResolvedName::LambdaParam { .. }) => (TT_PARAMETER, 0),
                Some(ResolvedName::Function(fn_id)) => {
                    if let Some(m) = method_mods.get(fn_id) { (TT_METHOD, *m) }
                    else { (TT_FUNCTION, function_mods.get(fn_id).copied().unwrap_or(0)) }
                }
                Some(ResolvedName::Struct(_))                            => (TT_STRUCT, 0),
                Some(ResolvedName::Enum(_) | ResolvedName::EnumVariant(..)) => (TT_ENUM, 0),
                Some(ResolvedName::Trait(_))                             => (TT_INTERFACE, 0),
                Some(ResolvedName::TypeAlias(_))                         => (TT_TYPE, 0),
                Some(ResolvedName::Module(_))                            => (TT_NAMESPACE, 0),
                Some(ResolvedName::Const(_))                             => (TT_VARIABLE, 0),
                _ => continue,
            };
            out.push(RawToken { start: id_start as u32, end: end as u32, token_type: tt, mods, resolved: true });
        }
    }
}

fn finalize_tokens(mut raw: Vec<RawToken>) -> Vec<SemToken> {
    let is_hir_preferred = |tt: u32| matches!(tt, TT_FUNCTION | TT_METHOD | TT_VARIABLE | TT_STRUCT | TT_ENUM | TT_INTERFACE | TT_PARAMETER);
    let (mut preferred, mut fallback): (Vec<_>, Vec<_>) = raw.drain(..).partition(|t| is_hir_preferred(t.token_type));
    preferred.sort_by_key(|t| (t.start, t.end, !t.resolved as u32));
    fallback.sort_by_key(|t| (t.start, t.end));
    let mut kept_pref: Vec<RawToken> = Vec::new();
    for t in preferred {
        if kept_pref.last().is_some_and(|k: &RawToken| k.end > t.start) { continue; }
        kept_pref.push(t);
    }
    let mut pi = 0usize;
    let mut kept_fall: Vec<RawToken> = Vec::new();
    for t in fallback {
        while kept_pref.get(pi).is_some_and(|p| p.end <= t.start) { pi += 1; }
        if kept_pref.get(pi).is_some_and(|p| p.start < t.end && t.start < p.end) { continue; }
        if kept_fall.last().is_some_and(|k: &RawToken| k.end > t.start) { continue; }
        kept_fall.push(t);
    }
    kept_pref.extend(kept_fall);
    kept_pref.sort_by_key(|t| t.start);
    kept_pref.iter().map(|t| SemToken { start: t.start, length: t.end - t.start, token_type: t.token_type, mods: t.mods }).collect()
}

/// Return semantic tokens for `source` (use_std disabled for speed).
/// Returns `[{start, length, type, mods}]`.
#[wasm_bindgen]
pub fn riddle_semantic_tokens(source: &str) -> JsValue {
    let opts = CompileOptions { use_std: false };
    let result = resolve_with_options(source, opts);
    let tokens = lex(source);
    let mut raw: Vec<RawToken> = Vec::new();
    for (i, _) in tokens.iter().enumerate() {
        let Some((tt, mods)) = lexer_token_type(&tokens, i, source) else { continue };
        let tok = &tokens[i];
        raw.push(RawToken { start: tok.span.start as u32, end: tok.span.end as u32, token_type: tt, mods, resolved: false });
    }
    collect_hir_tokens(source, &result, &tokens, &mut raw);
    let out = finalize_tokens(raw);
    serde_wasm_bindgen::to_value(&out).unwrap()
}

// ============================================================================
// Completions — ported from riddle-lsp/src/completion.rs
// ============================================================================

const COMPLETION_MARKER: &str = "__riddle_completion";

const COMPLETION_KEYWORDS: &[&str] = &[
    "let", "fun", "struct", "if", "else", "while", "break", "continue", "return",
    "as", "self", "mod", "use", "mut", "pub", "super", "crate", "enum", "trait",
    "impl", "match", "const", "type", "extern", "unsafe", "safe", "for", "in",
    "where", "true", "false",
];

#[derive(Serialize)]
pub struct CompletionItem {
    pub label: String,
    pub kind: u32,   // 1=keyword,2=function,3=method,4=variable,5=struct,6=enum,7=interface,8=module,9=constant,10=type
    pub detail: Option<String>,
}

// kind constants
const CK_KEYWORD:   u32 = 1;
const CK_FUNCTION:  u32 = 2;
const CK_METHOD:    u32 = 3;
const CK_VARIABLE:  u32 = 4;
const CK_STRUCT:    u32 = 5;
const CK_ENUM:      u32 = 6;
const CK_INTERFACE: u32 = 7;
const CK_MODULE:    u32 = 8;
const CK_CONSTANT:  u32 = 9;
const CK_TYPE:      u32 = 10;
const CK_FIELD:     u32 = 11;

fn is_ident_continue(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn ident_start(source: &str, offset: usize) -> usize {
    source[..offset].char_indices().rev()
        .find(|(_, c)| !is_ident_continue(*c))
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0)
}

fn ident_end(source: &str, offset: usize) -> usize {
    source[offset..].char_indices()
        .find(|(_, c)| !is_ident_continue(*c))
        .map(|(i, _)| offset + i)
        .unwrap_or(source.len())
}

#[derive(PartialEq)]
enum CCtx { General, Type, Member, Associated }

fn completion_context(source: &str, start: usize, end: usize) -> CCtx {
    let before = &source[..start];
    if before.ends_with('.') {
        CCtx::Member
    } else if before.ends_with("::") {
        CCtx::Associated
    } else {
        // check if in type position via a parse probe
        let mut marked = source.to_string();
        marked.replace_range(start..end, COMPLETION_MARKER);
        let tokens = lex(&marked);
        let marker_pos = start as u32;
        let in_type = tokens.windows(2).any(|w| {
            // colon before marker at type annotation position
            w[1].span.start as u32 == marker_pos && w[0].kind == SyntaxKind::Colon
        }) || tokens.windows(2).any(|w| {
            w[1].span.start as u32 == marker_pos && w[0].kind == SyntaxKind::Arrow
        });
        if in_type { CCtx::Type } else { CCtx::General }
    }
}

fn mk_item(label: &str, kind: u32, detail: Option<String>) -> CompletionItem {
    CompletionItem { label: label.into(), kind, detail }
}

fn function_item(f: &HirFunction, kind: u32) -> CompletionItem {
    let params: Vec<String> = f.params.iter().map(|p| {
        if p.name.0 == "self" {
            match &p.ty {
                HirTypeRef::Ref(_, true)  => "&mut self".into(),
                HirTypeRef::Ref(_, false) => "&self".into(),
                _                         => "self".into(),
            }
        } else {
            format!("{}: {}", p.name.0, p.ty.display())
        }
    }).collect();
    let ret = f.ret_type.as_ref().map(HirTypeRef::display).unwrap_or_else(|| "()".into());
    mk_item(&f.name.0, kind, Some(format!("fun {}({}) -> {ret}", f.name.0, params.join(", "))))
}

fn push_top_level(hir: &hir::HirFile, item: TopLevelItem, out: &mut Vec<CompletionItem>) {
    match item {
        TopLevelItem::Function(id) => {
            let f = &hir.item_tree.functions[id];
            out.push(function_item(f, CK_FUNCTION));
        }
        TopLevelItem::Struct(id) => {
            let s = &hir.item_tree.structs[id];
            out.push(mk_item(&s.name.0, CK_STRUCT, Some(format!("struct {}", s.name.0))));
        }
        TopLevelItem::Enum(id) => {
            let e = &hir.item_tree.enums[id];
            out.push(mk_item(&e.name.0, CK_ENUM, Some(format!("enum {}", e.name.0))));
        }
        TopLevelItem::Trait(id) => {
            let t = &hir.item_tree.traits[id];
            out.push(mk_item(&t.name.0, CK_INTERFACE, Some(format!("trait {}", t.name.0))));
        }
        TopLevelItem::Module(id) => {
            let m = &hir.item_tree.modules[id];
            out.push(mk_item(&m.name.0, CK_MODULE, Some(format!("mod {}", m.name.0))));
        }
        TopLevelItem::Const(id) => {
            let c = &hir.item_tree.consts[id];
            out.push(mk_item(&c.name.0, CK_CONSTANT, Some(c.ty.display())));
        }
        TopLevelItem::TypeAlias(id) => {
            let ta = &hir.item_tree.type_aliases[id];
            out.push(mk_item(&ta.name.0, CK_TYPE, ta.ty.as_ref().map(HirTypeRef::display)));
        }
        TopLevelItem::Use(_) | TopLevelItem::Impl(_) => {}
    }
}

fn collect_global(hir: &hir::HirFile, out: &mut Vec<CompletionItem>) {
    for &item in &hir.item_tree.top_level {
        push_top_level(hir, item, out);
    }
}

fn collect_member(
    hir: &hir::HirFile,
    marker: &str,
    types: &type_checker::TypeCheckResult,
    out: &mut Vec<CompletionItem>,
) {
    // Find receiver type via FieldAccess whose field matches marker
    let receiver = hir.bodies.iter().find_map(|(body_id, body)| {
        body.exprs.iter().find_map(|(_, expr)| {
            if let Expr::FieldAccess { base, field } = expr {
                if field.0 == marker {
                    return types.expr_types.get(&(body_id, *base));
                }
            }
            None
        })
    });
    let Some(receiver_ty) = receiver else { return };

    fn struct_id_of(ty: &type_checker::Type) -> Option<hir::item_tree::StructId> {
        match ty {
            type_checker::Type::Struct(id, _) => Some(*id),
            type_checker::Type::Ref(inner, _) | type_checker::Type::Ptr { inner, .. } => struct_id_of(inner),
            _ => None,
        }
    }

    if let Some(sid) = struct_id_of(receiver_ty) {
        let s = &hir.item_tree.structs[sid];
        for field in &s.fields {
            out.push(mk_item(&field.name.0, CK_FIELD, Some(field.ty.display())));
        }
    }
    for (_, impl_item) in hir.item_tree.impls.iter() {
        for fn_id in &impl_item.methods {
            let f = &hir.item_tree.functions[*fn_id];
            if f.params.first().is_some_and(|p| p.name.0 == "self") {
                out.push(function_item(f, CK_METHOD));
            }
        }
    }
}

fn collect_visible(
    hir: &hir::HirFile,
    sg: &ScopeGraph,
    reference: NodeId,
    body_id: hir::body::BodyId,
    out: &mut Vec<CompletionItem>,
) {
    for (name, def) in visible_definitions(sg, reference) {
        match def {
            DefRef::Function(id) => out.push(function_item(&hir.item_tree.functions[id], CK_FUNCTION)),
            DefRef::Struct(id)   => out.push(mk_item(&name.0, CK_STRUCT, Some(format!("struct {}", hir.item_tree.structs[id].name.0)))),
            DefRef::Enum(id)     => out.push(mk_item(&name.0, CK_ENUM, Some(format!("enum {}", hir.item_tree.enums[id].name.0)))),
            DefRef::Trait(id)    => out.push(mk_item(&name.0, CK_INTERFACE, Some(format!("trait {}", hir.item_tree.traits[id].name.0)))),
            DefRef::Module { .. } => out.push(mk_item(&name.0, CK_MODULE, None)),
            DefRef::Local { stmt } => {
                if let Stmt::Let { ty, .. } = &hir.bodies[body_id].stmts[stmt] {
                    out.push(mk_item(&name.0, CK_VARIABLE, (ty != &HirTypeRef::Unknown).then(|| ty.display())));
                }
            }
            DefRef::Param { fn_id, index } => {
                let param = &hir.item_tree.functions[fn_id].params[index];
                out.push(mk_item(&name.0, CK_VARIABLE, Some(param.ty.display())));
            }
            DefRef::EnumVariant { enum_id, index } => {
                let e = &hir.item_tree.enums[enum_id];
                out.push(mk_item(&name.0, CK_ENUM, Some(format!("{}::{}", e.name.0, e.variants[index].name.0))));
            }
            _ => out.push(mk_item(&name.0, CK_VARIABLE, None)),
        }
    }
}

fn collect_associated(
    hir: &hir::HirFile,
    sg: &ScopeGraph,
    reference: NodeId,
    body_id: hir::body::BodyId,
    qualifier: &[hir::Name],
    out: &mut Vec<CompletionItem>,
) {
    for def in resolve_path_at_reference(sg, reference, qualifier) {
        let definitions = match def {
            DefRef::Module { enter, .. } => exported_definitions(sg, enter),
            DefRef::Struct(id) => sg.impl_scopes_by_struct.get(&id)
                .map(|s| exported_definitions(sg, *s)).unwrap_or_default(),
            DefRef::Enum(id) => sg.variant_scopes_by_enum.get(&id)
                .map(|s| exported_definitions(sg, *s)).unwrap_or_default(),
            _ => vec![],
        };
        for (name, associated) in definitions {
            if let DefRef::Function(id) = &associated {
                let f = &hir.item_tree.functions[*id];
                if f.params.first().is_some_and(|p| p.name.0 == "self") { continue; }
                out.push(function_item(f, CK_FUNCTION));
            } else {
                match associated {
                    DefRef::Struct(id)   => out.push(mk_item(&name.0, CK_STRUCT, None)),
                    DefRef::Enum(id)     => out.push(mk_item(&name.0, CK_ENUM, None)),
                    DefRef::EnumVariant { enum_id, index } => {
                        let e = &hir.item_tree.enums[enum_id];
                        out.push(mk_item(&name.0, CK_ENUM, Some(format!("{}::{}", e.name.0, e.variants[index].name.0))));
                    }
                    DefRef::Const(id) => out.push(mk_item(&name.0, CK_CONSTANT, None)),
                    _ => {}
                }
            }
        }
    }
}

fn find_marker_reference<'a>(
    hir: &'a hir::HirFile,
    sg: &'a ScopeGraph,
) -> Option<(NodeId, hir::body::BodyId, &'a hir::item_tree::HirPath)> {
    for (body_id, body) in hir.bodies.iter() {
        for (expr_id, expr) in body.exprs.iter() {
            let Expr::Path { path, .. } = expr else { continue };
            if path.segments.last().is_none_or(|n| n.0 != COMPLETION_MARKER) { continue }
            let reference = sg.nodes.iter().find_map(|(nid, node)| {
                matches!(node, scope_graph::Node::Reference { origin: RefOrigin::Expr { body, expr }, .. } if *body == body_id && *expr == expr_id).then_some(nid)
            })?;
            return Some((reference, body_id, path));
        }
    }
    None
}

/// Return completion items at `offset` (byte position) in `source`.
/// Returns `[{label, kind, detail?}]`.
#[wasm_bindgen]
pub fn riddle_completions(source: &str, offset: u32) -> JsValue {
    let offset = offset as usize;
    if offset > source.len() {
        return serde_wasm_bindgen::to_value(&Vec::<CompletionItem>::new()).unwrap();
    }
    let start = ident_start(source, offset);
    let end   = ident_end(source, offset);
    let prefix = source[start..offset].to_lowercase();
    let ctx = completion_context(source, start, end);

    let mut marked = source.to_string();
    marked.replace_range(start..end, COMPLETION_MARKER);
    let opts = CompileOptions { use_std: false };

    let mut result = if ctx == CCtx::Member {
        check_with_options(&marked, opts)
    } else {
        resolve_with_options(&marked, opts)
    };
    // Recovery: insert semicolon if HIR parse failed
    if result.hir.is_none() {
        let marker_end = start + COMPLETION_MARKER.len();
        if !marked[marker_end..].trim_start().starts_with(';') {
            marked.insert(marker_end, ';');
            result = if ctx == CCtx::Member { check_with_options(&marked, opts) } else { resolve_with_options(&marked, opts) };
        }
    }

    let mut items: Vec<CompletionItem> = Vec::new();

    if ctx == CCtx::General {
        items.extend(COMPLETION_KEYWORDS.iter().map(|kw| mk_item(kw, CK_KEYWORD, Some("keyword".into()))));
    }
    if matches!(ctx, CCtx::General | CCtx::Type) {
        items.extend(BUILTIN_TYPES.iter().map(|t| mk_item(t, CK_TYPE, Some("builtin type".into()))));
    }

    if let (Some(hir), Some(sg)) = (result.hir.as_ref(), result.scope_graph.as_ref()) {
        match ctx {
            CCtx::General => {
                if let Some((ref_id, body_id, _)) = find_marker_reference(hir, sg) {
                    collect_visible(hir, sg, ref_id, body_id, &mut items);
                } else {
                    collect_global(hir, &mut items);
                }
            }
            CCtx::Type => { collect_global(hir, &mut items); }
            CCtx::Member => {
                let types = if result.type_result.expr_types.is_empty() {
                    type_checker::check_hir(hir)
                } else {
                    result.type_result.clone()
                };
                collect_member(hir, COMPLETION_MARKER, &types, &mut items);
            }
            CCtx::Associated => {
                if let Some((ref_id, body_id, path)) = find_marker_reference(hir, sg) {
                    let qualifier = &path.segments[..path.segments.len().saturating_sub(1)];
                    collect_associated(hir, sg, ref_id, body_id, qualifier, &mut items);
                }
            }
        }
    }

    items.retain(|i| i.label.to_lowercase().starts_with(&prefix));
    items.sort_by(|a, b| a.label.cmp(&b.label));
    items.dedup_by(|a, b| a.label == b.label && a.kind == b.kind);
    serde_wasm_bindgen::to_value(&items).unwrap()
}

// ============================================================================
// Inlay hints — ported from riddle-lsp/src/inlay_hints.rs
// ============================================================================

#[derive(Serialize)]
pub struct InlayHint {
    pub offset: u32,
    pub label: String,
}

/// Return inlay type hints for `source`.
/// Returns `[{offset, label}]` where offset is the byte end of the variable name.
#[wasm_bindgen]
pub fn riddle_inlay_hints(source: &str) -> JsValue {
    let opts = CompileOptions { use_std: false };
    let result = check_with_options(source, opts);
    let Some(hir) = &result.hir else {
        return serde_wasm_bindgen::to_value(&Vec::<InlayHint>::new()).unwrap();
    };
    let type_result = &result.type_result;
    let source_len = source.len();
    let mut hints = Vec::new();

    for (body_id, body) in hir.bodies.iter() {
        for (_, stmt) in body.stmts.iter() {
            let Stmt::Let {
                name_range: Some(name_range),
                ty: HirTypeRef::Unknown,
                init: Some(init),
                ..
            } = stmt else { continue };

            if matches!(body.exprs[*init], Expr::Struct { .. }) { continue; }
            let Some(init_range) = body.source_map.expr_ranges.get(init).copied() else { continue };

            // Skip if there are errors overlapping the initializer
            let has_error = result.hir_diagnostics.iter()
                .chain(type_result.diagnostics.iter())
                .filter(|d| d.severity == type_checker::Severity::Error)
                .flat_map(|d| &d.labels)
                .any(|l| {
                    let a = l.range;
                    let b = init_range;
                    a.start() < b.end() && b.start() < a.end()
                });
            if has_error { continue; }

            let Some(ty) = type_result.expr_types.get(&(body_id, *init)) else { continue };
            if matches!(ty, type_checker::Type::Unknown | type_checker::Type::Error | type_checker::Type::InferVar(_) | type_checker::Type::Never) { continue; }
            if usize::from(name_range.end()) > source_len { continue; }

            hints.push(InlayHint {
                offset: u32::from(name_range.end()),
                label:  format!(": {}", ty.display(hir)),
            });
        }
    }

    hints.sort_by_key(|h| h.offset);
    serde_wasm_bindgen::to_value(&hints).unwrap()
}
