/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gc/Tracer.h"

#include "mozilla/DebugOnly.h"

#include "NamespaceImports.h"

#include "gc/PublicIterators.h"
#include "jit/JitCode.h"
#include "jit/JitScript.h"
#include "js/friend/CycleCollector.h"
#include "util/Memory.h"
#include "util/Text.h"
#include "vm/BigIntType.h"
#include "vm/JSContext.h"
#include "vm/JSFunction.h"
#include "vm/JSScript.h"
#include "vm/RegExpShared.h"
#include "vm/Scope.h"
#include "vm/Shape.h"
#include "vm/StringType.h"
#include "vm/SymbolType.h"

#include "gc/TraceMethods-inl.h"
#include "vm/Shape-inl.h"

using namespace js;
using namespace js::gc;

template void RuntimeScopeData<LexicalScope::SlotInfo>::trace(JSTracer* trc);
template void RuntimeScopeData<ClassBodyScope::SlotInfo>::trace(JSTracer* trc);
template void RuntimeScopeData<VarScope::SlotInfo>::trace(JSTracer* trc);
template void RuntimeScopeData<GlobalScope::SlotInfo>::trace(JSTracer* trc);
template void RuntimeScopeData<EvalScope::SlotInfo>::trace(JSTracer* trc);
template void RuntimeScopeData<WasmFunctionScope::SlotInfo>::trace(
    JSTracer* trc);

void JS::TracingContext::getEdgeName(const char* name, char* buffer,
                                     size_t bufferSize) {
  MOZ_ASSERT(bufferSize > 0);
  if (weak_) {
    snprintf(buffer, bufferSize, "[weak] %s", name);
    return;
  }
  if (nesting_ != 0) {
    snprintf(buffer, bufferSize, "[nesting=%zu] %s", nesting_, name);
    return;
  }
  if (functor_) {
    (*functor_)(this, name, buffer, bufferSize);
    return;
  }
  if (index_ != InvalidIndex) {
    snprintf(buffer, bufferSize, "%s[%zu]", name, index_);
    return;
  }
  snprintf(buffer, bufferSize, "%s", name);
}

/*** Public Tracing API *****************************************************/

JS_PUBLIC_API void JS::TraceChildren(JSTracer* trc, GCCellPtr thing) {
  ApplyGCThingTyped(thing.asCell(), thing.kind(), [trc](auto t) {
    MOZ_ASSERT_IF(t->runtimeFromAnyThread() != trc->runtime(),
                  t->isPermanentAndMayBeShared());
    t->traceChildren(trc);
  });
}

void js::gc::TraceIncomingCCWs(JSTracer* trc,
                               const JS::CompartmentSet& compartments) {
  for (CompartmentsIter source(trc->runtime()); !source.done(); source.next()) {
    if (compartments.has(source)) {
      continue;
    }
    // Iterate over all compartments that |source| has wrappers for.
    for (auto dest = source->wrappedObjectCompartments(); !dest.done();
         dest.next()) {
      if (!compartments.has(dest)) {
        continue;
      }
      // Iterate over all wrappers from |source| to |dest| compartments.
      for (auto iter = source->objectWrapperMappingsTo(dest); !iter.done();
           iter.next()) {
        JSObject* obj = iter.get().key();
        MOZ_ASSERT(compartments.has(obj->compartment()));
        mozilla::DebugOnly<JSObject*> prior = obj;
        TraceManuallyBarrieredEdge(trc, &obj,
                                   "cross-compartment wrapper target");
        MOZ_ASSERT(obj == prior);
      }
    }
  }
}

/*** Cycle Collector Helpers ************************************************/

static bool sCCShapeScanCounting = false;
static thread_local uint64_t sCCShapeMapsScanned = 0;
static thread_local uint64_t sCCShapeKeysScanned = 0;

JS_PUBLIC_API void JS_SetCCShapeScanCounting(bool enabled) {
  sCCShapeScanCounting = enabled;
}

JS_PUBLIC_API void JS_GetCCShapeScanCounters(uint64_t* maps, uint64_t* keys) {
  *maps = sCCShapeMapsScanned;
  *keys = sCCShapeKeysScanned;
}

// This function is used by the Cycle Collector (CC) to traverse a Shape. Shapes
// are CC graph nodes, but the CC does not care about BaseShapes or PropMaps
// themselves, only things held live by them that can participate in cycles.
void gc::TraceCycleCollectorChildren(JSTracer* trc, Shape* shape) {
  // If the proto is in the same realm, the realm's global is reachable from
  // the proto's shape, so the edge to it would be redundant in the CC graph.
  static const bool sSkipGlobal = !getenv("CCBENCH_NO_GLOBAL_SKIP");
  BaseShape* base = shape->base();
  TaggedProto proto = base->proto();
  if (sSkipGlobal && proto.isObject() &&
      proto.toObject()->shape()->realm() == base->realm()) {
    JSObject* protoObj = proto.toObject();
    TraceManuallyBarrieredEdge(trc, &protoObj, "baseshape_proto");
    MOZ_ASSERT(protoObj == proto.toObject());
  } else {
    base->traceChildren(trc);
  }

  // Trace symbols reachable through property maps.
  if (shape->isNative()) {
    PropMap* map = shape->asNative().propMap();
    while (map) {
      if (sCCShapeScanCounting) {
        sCCShapeMapsScanned++;
        sCCShapeKeysScanned += PropMap::Capacity;
      }
      for (uint32_t index = 0; index < PropMap::Capacity; index++) {
        PropertyKey key = map->getKey(index);
        if (key.isSymbol()) {
          TraceManuallyBarrieredEdge(trc, &key, "propmap_key");
        }
      }

      if (map->isShared()) {
        map = map->asShared()->treeDataRef().parent.maybeMap();
      } else {
        map = map->asLinked()->previous();
      }
    }
  }
}

static MOZ_ALWAYS_INLINE void AddGrayCCChildren(JSTracer* trc,
                                                GrayCCChildSink* sink,
                                                const HeapSlot* slots,
                                                uint32_t length) {
  for (const HeapSlot* vp = slots; vp != slots + length; vp++) {
    const Value& v = vp->unbarrieredGet();
    if (v.isObject()) {
      JSObject* obj = &v.toObject();
      if (JS::GCThingIsMarkedGrayInCC(obj)) {
        sink->append(JS::GCCellPtr(obj));
      }
    } else if (v.isSymbol()) {
      JS::Symbol* sym = v.toSymbol();
      if (JS::GCThingIsMarkedGrayInCC(sym)) {
        sink->append(JS::GCCellPtr(sym));
      }
    } else if (MOZ_UNLIKELY(v.isPrivateGCThing())) {
      sink->flush();
      Value copy = v;
      TraceManuallyBarrieredEdge(trc, &copy, "private gcthing");
      MOZ_ASSERT(copy == v);
    }
    // Strings and BigInts are not CC graph nodes and have no children that are.
  }
}

JS_PUBLIC_API void js::TraceGrayCCChildren(JSTracer* trc, JSObject* obj,
                                           GrayCCChildSink* sink) {
  Shape* shape = obj->shape();
  if (JS::GCThingIsMarkedGrayInCC(shape)) {
    sink->append(JS::GCCellPtr(shape));
  }

  if (shape->isNative()) {
    NativeObject* nobj = &obj->as<NativeObject>();
    uint32_t nslots = nobj->slotSpan();
    uint32_t nfixed = nobj->numFixedSlots();
    AddGrayCCChildren(trc, sink, nobj->getSlotAddressUnchecked(0),
                      std::min(nslots, nfixed));
    if (nslots > nfixed) {
      AddGrayCCChildren(trc, sink, nobj->getSlotsUnchecked(), nslots - nfixed);
    }
    AddGrayCCChildren(trc, sink, nobj->getDenseElements().begin(),
                      nobj->getDenseInitializedLength());
  }

  const JSClass* clasp = shape->getObjectClass();
  if (clasp->hasTrace()) {
    sink->flush();
    clasp->doTrace(trc, obj);
  }
  sink->flush();
}

template <typename T>
static MOZ_ALWAYS_INLINE void AddGrayCCChild(GrayCCChildSink* sink, T* thing) {
  if (thing && JS::GCThingIsMarkedGrayInCC(thing)) {
    sink->append(JS::GCCellPtr(thing));
  }
}

static void TraceGrayCCScriptChildren(JSTracer* trc, BaseScript* script,
                                      GrayCCChildSink* sink) {
  AddGrayCCChild(sink, script->function());
  AddGrayCCChild(sink, script->sourceObject());
  for (JS::GCCellPtr thing : script->gcthings()) {
    if (thing && JS::IsCCTraceKind(thing.kind()) &&
        JS::GCThingIsMarkedGrayInCC(thing)) {
      sink->append(thing);
    }
  }
  const ScriptWarmUpData& warmUp = script->warmUpDataForTracing();
  if (warmUp.isEnclosingScript()) {
    AddGrayCCChild(sink, warmUp.toEnclosingScript());
  } else if (warmUp.isEnclosingScope()) {
    AddGrayCCChild(sink, warmUp.toEnclosingScope());
  } else if (warmUp.isJitScript()) {
    sink->flush();
    warmUp.toJitScript()->trace(trc);
  }
}

static void TraceGrayCCScopeChildren(Scope* scope, GrayCCChildSink* sink) {
  AddGrayCCChild(sink, scope->environmentShape());
  AddGrayCCChild(sink, scope->enclosing());
  // Binding names are atoms, which are not CC graph nodes.
  switch (scope->kind()) {
    case ScopeKind::Function:
      AddGrayCCChild(sink, scope->as<FunctionScope>().canonicalFunction());
      break;
    case ScopeKind::Module:
      AddGrayCCChild(sink, scope->as<ModuleScope>().module());
      break;
    case ScopeKind::WasmInstance:
      AddGrayCCChild(sink, scope->as<WasmInstanceScope>().instance());
      break;
    default:
      break;
  }
}

JS_PUBLIC_API bool js::TraceGrayCCChildren(JSTracer* trc, JS::GCCellPtr thing,
                                           GrayCCChildSink* sink) {
  switch (thing.kind()) {
    case JS::TraceKind::Object:
      TraceGrayCCChildren(trc, &thing.as<JSObject>(), sink);
      return true;
    case JS::TraceKind::Script:
      TraceGrayCCScriptChildren(trc, &thing.as<BaseScript>(), sink);
      break;
    case JS::TraceKind::Scope:
      TraceGrayCCScopeChildren(&thing.as<Scope>(), sink);
      break;
    default:
      return false;
  }
  sink->flush();
  return true;
}

/*** Traced Edge Printer ****************************************************/

static size_t CountDecimalDigits(size_t num) {
  size_t numDigits = 0;
  do {
    num /= 10;
    numDigits++;
  } while (num > 0);

  return numDigits;
}

static const char* StringKindHeader(JSString* str) {
  MOZ_ASSERT(str->isLinear());

  if (str->isAtom()) {
    if (str->isPermanentAtom()) {
      return "permanent atom: ";
    }
    return "atom: ";
  }

  if (str->isExtensible()) {
    return "extensible: ";
  }

  if (str->isInline()) {
    if (str->isFatInline()) {
      return "fat inline: ";
    }
    return "inline: ";
  }

  if (str->isDependent()) {
    return "dependent: ";
  }

  if (str->isExternal()) {
    return "external: ";
  }

  return "linear: ";
}

void js::gc::GetTraceThingInfo(char* buf, size_t bufsize, void* thing,
                               JS::TraceKind kind, bool details) {
  const char* name = nullptr; /* silence uninitialized warning */
  size_t n;

  if (bufsize == 0) {
    return;
  }

  switch (kind) {
    case JS::TraceKind::BaseShape:
      name = "base_shape";
      break;

    case JS::TraceKind::GetterSetter:
      name = "getter_setter";
      break;

    case JS::TraceKind::PropMap:
      name = "prop_map";
      break;

    case JS::TraceKind::JitCode:
      name = "jitcode";
      break;

    case JS::TraceKind::Null:
      name = "null_pointer";
      break;

    case JS::TraceKind::Object: {
      name = static_cast<JSObject*>(thing)->getClass()->name;
      break;
    }

    case JS::TraceKind::RegExpShared:
      name = "reg_exp_shared";
      break;

    case JS::TraceKind::Scope:
      name = "scope";
      break;

    case JS::TraceKind::Script:
      name = "script";
      break;

    case JS::TraceKind::Shape:
      name = "shape";
      break;

    case JS::TraceKind::String:
      name = ((JSString*)thing)->isDependent() ? "substring" : "string";
      break;

    case JS::TraceKind::Symbol:
      name = "symbol";
      break;

    case JS::TraceKind::BigInt:
      name = "BigInt";
      break;

    default:
      name = "INVALID";
      break;
  }

  n = strlen(name);
  if (n > bufsize - 1) {
    n = bufsize - 1;
  }
  js_memcpy(buf, name, n + 1);
  buf += n;
  bufsize -= n;
  *buf = '\0';

  if (details && bufsize > 2) {
    switch (kind) {
      case JS::TraceKind::Object: {
        JSObject* obj = (JSObject*)thing;
        if (obj->is<JSFunction>()) {
          JSFunction* fun = &obj->as<JSFunction>();
          if (fun->maybePartialDisplayAtom()) {
            *buf++ = ' ';
            bufsize--;
            PutEscapedString(buf, bufsize, fun->maybePartialDisplayAtom(), 0);
          }
        } else if (obj->is<NativeObject>()) {
          uint32_t nslots = JSCLASS_RESERVED_SLOTS(obj->getClass());
          if (nslots > 0) {
            for (uint32_t ix = 0; ix < nslots; ix++) {
              JS::Value slot = obj->as<NativeObject>().getReservedSlot(0);
              // PrivateValues are aliased with doubles
              if (!slot.isDouble()) continue;
              int written = snprintf(buf, bufsize, " %u:Private(%p)", ix,
                                     slot.toPrivateUnchecked());
              buf += written;
              bufsize -= written;
            }
          } else {
            snprintf(buf, bufsize, " <unknown object>");
          }
        } else {
          snprintf(buf, bufsize, " <unknown object>");
        }
        break;
      }

      case JS::TraceKind::Script: {
        auto* script = static_cast<js::BaseScript*>(thing);
        snprintf(buf, bufsize, " %s:%u", script->filename(), script->lineno());
        break;
      }

      case JS::TraceKind::String: {
        *buf++ = ' ';
        bufsize--;
        JSString* str = (JSString*)thing;

        if (str->isLinear()) {
          const char* header = StringKindHeader(str);
          bool willFit = str->length() + strlen("<length > ") + strlen(header) +
                             CountDecimalDigits(str->length()) <
                         bufsize;

          n = snprintf(buf, bufsize, "<%slength %zu%s> ", header, str->length(),
                       willFit ? "" : " (truncated)");
          buf += n;
          bufsize -= n;

          PutEscapedString(buf, bufsize, &str->asLinear(), 0);
        } else {
          snprintf(buf, bufsize, "<rope: length %zu>", str->length());
        }
        break;
      }

      case JS::TraceKind::Symbol: {
        *buf++ = ' ';
        bufsize--;
        auto* sym = static_cast<JS::Symbol*>(thing);
        if (JSAtom* desc = sym->description()) {
          PutEscapedString(buf, bufsize, desc, 0);
        } else {
          snprintf(buf, bufsize, "<null>");
        }
        break;
      }

      case JS::TraceKind::Scope: {
        auto* scope = static_cast<js::Scope*>(thing);
        snprintf(buf, bufsize, " %s", js::ScopeKindString(scope->kind()));
        break;
      }

      default:
        break;
    }
  }
  buf[bufsize - 1] = '\0';
}

JS::CallbackTracer::CallbackTracer(JSContext* cx, JS::TracerKind kind,
                                   JS::TraceOptions options)
    : CallbackTracer(cx->runtime(), kind, options) {}
