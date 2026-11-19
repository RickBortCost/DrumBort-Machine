// vst3host.cpp — Host VST 3 minimo per DrumBort (effetti audio stereo), con API C per il C#.
//
//   dbv_scan          classi di un file .vst3 (JSON)
//   dbv_open/close    istanza di un effetto (componente + controller collegati)
//   dbv_process       elabora un blocco stereo (thread audio)
//   dbv_param_*       parametri (normalizzati 0..1); le modifiche arrivano al processore al blocco dopo
//   dbv_get/set_state stato completo (componente + controller) per salvarlo nel progetto
//   dbv_editor_*      finestra del plugin dentro una finestra dell'host (HWND su Windows)

#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "public.sdk/source/common/memorystream.h"
#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"

#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#if defined(_WIN32)
#define DBV_API extern "C" __declspec(dllexport)
#else
#define DBV_API extern "C" __attribute__((visibility("default")))
#endif

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

IPtr<HostApplication> gHost;
std::string gError;

void EnsureHost()
{
	if (gHost) return;
	gHost = owned(new HostApplication());
	PluginContextFactory::instance().setPluginContext(gHost);
}

std::string Json(const std::string& s)
{
	std::string o;
	for (char c : s)
	{
		if (c == '"' || c == '\\') { o += '\\'; o += c; }
		else if ((unsigned char)c < 0x20) o += ' ';
		else o += c;
	}
	return o;
}

int CopyOut(const std::string& s, char* out, int cap)
{
	if (out && cap > 0)
	{
		size_t n = std::min<size_t>(s.size(), (size_t)cap - 1);
		std::memcpy(out, s.data(), n);
		out[n] = 0;
	}
	return (int)s.size();
}

struct Plugin;

/// Modifiche fatte nella finestra del plugin: al processore come parameter changes.
class Handler : public U::Implements<U::Directly<IComponentHandler>>
{
public:
	explicit Handler(Plugin* p) : plug(p) {}
	tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
	tresult PLUGIN_API performEdit(ParamID id, ParamValue v) override;
	tresult PLUGIN_API endEdit(ParamID) override { return kResultOk; }
	tresult PLUGIN_API restartComponent(int32) override { return kResultOk; }
	Plugin* plug;
};

/// Cornice dell'editor: il plugin chiede di cambiare dimensione.
class Frame : public U::Implements<U::Directly<IPlugFrame>>
{
public:
	tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* r) override
	{
		if (!view || !r) return kInvalidArgument;
		w = r->getWidth(); h = r->getHeight();
		view->onSize(r);
		return kResultOk;
	}
	int w = 0, h = 0;
};

struct Plugin
{
	VST3::Hosting::Module::Ptr module;
	IPtr<PlugProvider> provider;
	IPtr<IComponent> comp;
	IPtr<IAudioProcessor> proc;
	IPtr<IEditController> ctrl;
	IPtr<Handler> handler;
	IPtr<Frame> frame;
	IPtr<IPlugView> view;
	HostProcessData data;
	ParameterChanges inChanges, outChanges;
	EventList inEvents, outEvents;
	ProcessContext ctx {};
	std::mutex qlock;
	std::vector<std::pair<ParamID, ParamValue>> queue, work;
	std::string name;
	int32 maxBlock = 128;
	bool hasInput = false;

	void Push(ParamID id, ParamValue v)
	{
		std::lock_guard<std::mutex> g(qlock);
		queue.emplace_back(id, v);
	}
};

tresult PLUGIN_API Handler::performEdit(ParamID id, ParamValue v)
{
	plug->Push(id, v);
	return kResultOk;
}

bool FindClass(const VST3::Hosting::PluginFactory& f, const char* cid, VST3::Hosting::ClassInfo& out)
{
	for (auto& ci : f.classInfos())
	{
		if (ci.category() != kVstAudioEffectClass) continue;
		if (cid && *cid && ci.ID().toString() != cid) continue;
		out = ci;
		return true;
	}
	return false;
}

} // namespace

DBV_API const char* dbv_error() { return gError.c_str(); }

/// Classi audio del file .vst3: [{"cid","name","vendor","sub"}] (lunghezza del JSON; si richiama con cap sufficiente).
DBV_API int dbv_scan(const char* path, char* out, int cap)
{
	EnsureHost();
	std::string err;
	auto mod = VST3::Hosting::Module::create(path, err);
	if (!mod) { gError = err; return -1; }
	std::string j = "[";
	bool first = true;
	for (auto& ci : mod->getFactory().classInfos())
	{
		if (ci.category() != kVstAudioEffectClass) continue;
		if (!first) j += ",";
		first = false;
		j += "{\"cid\":\"" + ci.ID().toString() + "\",\"name\":\"" + Json(ci.name()) + "\",\"vendor\":\"" + Json(ci.vendor()) +
		     "\",\"sub\":\"" + Json(ci.subCategoriesString()) + "\"}";
	}
	j += "]";
	return CopyOut(j, out, cap);
}

DBV_API void* dbv_open(const char* path, const char* cid, double rate, int maxBlock)
{
	EnsureHost();
	auto p = new Plugin();
	std::string err;
	p->module = VST3::Hosting::Module::create(path, err);
	if (!p->module) { gError = err.empty() ? "modulo non caricato" : err; delete p; return nullptr; }
	VST3::Hosting::ClassInfo ci;
	auto factory = p->module->getFactory();
	if (!FindClass(factory, cid, ci)) { gError = "nessun effetto audio nel file"; delete p; return nullptr; }
	p->name = ci.name();
	p->provider = owned(new PlugProvider(factory, ci, true));
	if (!p->provider->initialize()) { gError = "inizializzazione del plugin non riuscita"; delete p; return nullptr; }
	p->comp = p->provider->getComponentPtr();
	p->ctrl = p->provider->getControllerPtr();
	p->proc = U::cast<IAudioProcessor>(p->comp);
	if (!p->comp || !p->proc) { gError = "il plugin non ha un processore audio"; delete p; return nullptr; }
	if (p->ctrl)
	{
		p->handler = owned(new Handler(p));
		p->ctrl->setComponentHandler(p->handler);
	}
	p->maxBlock = maxBlock;

	// Bus principali stereo (ingresso se presente, uscita)
	SpeakerArrangement st = SpeakerArr::kStereo;
	int32 nIn = p->comp->getBusCount(kAudio, kInput), nOut = p->comp->getBusCount(kAudio, kOutput);
	if (nOut < 1) { gError = "il plugin non ha uscite audio"; delete p; return nullptr; }
	p->hasInput = nIn > 0;
	std::vector<SpeakerArrangement> ins(nIn, st), outs(nOut, st);
	p->proc->setBusArrangements(nIn ? ins.data() : nullptr, nIn, outs.data(), nOut);
	if (nIn) p->comp->activateBus(kAudio, kInput, 0, true);
	p->comp->activateBus(kAudio, kOutput, 0, true);

	ProcessSetup setup {kRealtime, kSample32, maxBlock, rate};
	if (p->proc->setupProcessing(setup) != kResultOk) { gError = "formato non accettato dal plugin"; delete p; return nullptr; }
	p->data.prepare(*p->comp, maxBlock, kSample32);
	p->data.inputParameterChanges = &p->inChanges;
	p->data.outputParameterChanges = &p->outChanges;
	p->data.inputEvents = &p->inEvents;
	p->data.outputEvents = &p->outEvents;
	p->ctx.sampleRate = rate;
	p->ctx.tempo = 120;
	p->ctx.timeSigNumerator = 4; p->ctx.timeSigDenominator = 4;
	p->ctx.state = ProcessContext::kPlaying | ProcessContext::kTempoValid | ProcessContext::kTimeSigValid;
	p->data.processContext = &p->ctx;
	if (p->comp->setActive(true) != kResultOk) { gError = "attivazione non riuscita"; delete p; return nullptr; }
	p->proc->setProcessing(true);
	return p;
}

DBV_API const char* dbv_name(void* h) { return h ? ((Plugin*)h)->name.c_str() : ""; }
DBV_API void dbv_set_tempo(void* h, double bpm) { if (h) ((Plugin*)h)->ctx.tempo = bpm; }

/// Un blocco stereo (n ≤ maxBlock). Restituisce 0 se il plugin ha elaborato il blocco.
DBV_API int dbv_process(void* h, const float* inL, const float* inR, float* outL, float* outR, int n)
{
	auto p = (Plugin*)h;
	if (!p || n > p->maxBlock) return -1;
	auto& d = p->data;
	d.numSamples = n;
	if (p->hasInput && d.numInputs > 0 && d.inputs[0].numChannels > 0)
	{
		auto& b = d.inputs[0];
		std::memcpy(b.channelBuffers32[0], inL, n * sizeof(float));
		if (b.numChannels > 1) std::memcpy(b.channelBuffers32[1], inR, n * sizeof(float));
		b.silenceFlags = 0;
	}
	// Parametri cambiati da interfaccia, MIDI Learn o finestra del plugin
	{
		std::unique_lock<std::mutex> g(p->qlock, std::try_to_lock);
		if (g.owns_lock()) { p->work.swap(p->queue); p->queue.clear(); }
	}
	for (auto& [id, v] : p->work)
	{
		int32 qi = 0, pi = 0;
		if (auto q = p->inChanges.addParameterData(id, qi)) q->addPoint(0, v, pi);
	}
	p->work.clear();
	tresult r = p->proc->process(d);
	p->ctx.projectTimeSamples += n;
	p->inChanges.clearQueue();
	p->outChanges.clearQueue();
	p->inEvents.clear();
	p->outEvents.clear();
	if (r != kResultOk || d.numOutputs < 1 || d.outputs[0].numChannels < 1) return -2;
	auto& o = d.outputs[0];
	std::memcpy(outL, o.channelBuffers32[0], n * sizeof(float));
	std::memcpy(outR, o.channelBuffers32[o.numChannels > 1 ? 1 : 0], n * sizeof(float));
	return 0;
}

DBV_API int dbv_param_count(void* h) { auto p = (Plugin*)h; return p && p->ctrl ? p->ctrl->getParameterCount() : 0; }

/// {"id","name","units","steps","def","flags"} del parametro i.
DBV_API int dbv_param_info(void* h, int i, char* out, int cap)
{
	auto p = (Plugin*)h;
	ParameterInfo pi {};
	if (!p || !p->ctrl || p->ctrl->getParameterInfo(i, pi) != kResultOk) return -1;
	std::string j = "{\"id\":" + std::to_string(pi.id) + ",\"name\":\"" + Json(VST3::StringConvert::convert(pi.title)) +
	                "\",\"units\":\"" + Json(VST3::StringConvert::convert(pi.units)) + "\",\"steps\":" + std::to_string(pi.stepCount) +
	                ",\"def\":" + std::to_string(pi.defaultNormalizedValue) + ",\"flags\":" + std::to_string(pi.flags) + "}";
	return CopyOut(j, out, cap);
}

DBV_API double dbv_param_get(void* h, unsigned id) { auto p = (Plugin*)h; return p && p->ctrl ? p->ctrl->getParamNormalized(id) : 0; }

/// Valore leggibile (es. "-6.0 dB") del parametro al valore normalizzato v.
DBV_API int dbv_param_text(void* h, unsigned id, double v, char* out, int cap)
{
	auto p = (Plugin*)h;
	String128 s {};
	if (!p || !p->ctrl || p->ctrl->getParamStringByValue(id, v, s) != kResultOk) return -1;
	return CopyOut(VST3::StringConvert::convert(s), out, cap);
}

DBV_API void dbv_param_set(void* h, unsigned id, double v)
{
	auto p = (Plugin*)h;
	if (!p) return;
	if (p->ctrl) p->ctrl->setParamNormalized(id, v);
	p->Push(id, v);
}

/// Stato: [int32 lunghezza][componente][int32 lunghezza][controller]. Restituisce la dimensione necessaria.
DBV_API int dbv_get_state(void* h, unsigned char* out, int cap)
{
	auto p = (Plugin*)h;
	if (!p) return -1;
	auto cs = owned(new MemoryStream());
	auto es = owned(new MemoryStream());
	p->comp->getState(cs);
	if (p->ctrl) p->ctrl->getState(es);
	int32 a = (int32)cs->getSize(), b = (int32)es->getSize();
	int total = 8 + a + b;
	if (out && cap >= total)
	{
		std::memcpy(out, &a, 4);
		if (a) std::memcpy(out + 4, cs->getData(), a);
		std::memcpy(out + 4 + a, &b, 4);
		if (b) std::memcpy(out + 8 + a, es->getData(), b);
	}
	return total;
}

DBV_API int dbv_set_state(void* h, const unsigned char* buf, int len)
{
	auto p = (Plugin*)h;
	if (!p || len < 8) return -1;
	int32 a = 0, b = 0;
	std::memcpy(&a, buf, 4);
	if (a < 0 || 8 + a > len) return -2;
	std::memcpy(&b, buf + 4 + a, 4);
	if (b < 0 || 8 + a + b > len) return -2;
	auto cs = owned(new MemoryStream((void*)(buf + 4), a));
	if (p->comp->setState(cs) != kResultOk) return -3;
	if (p->ctrl)
	{
		int64 pos = 0;
		cs->seek(0, IBStream::kIBSeekSet, &pos);
		p->ctrl->setComponentState(cs);
		if (b > 0)
		{
			auto es = owned(new MemoryStream((void*)(buf + 8 + a), b));
			p->ctrl->setState(es);
		}
	}
	return 0;
}

/// Apre la finestra del plugin dentro `parent` (HWND). w/h = dimensione richiesta dal plugin.
DBV_API int dbv_editor_open(void* h, void* parent, int* w, int* hgt)
{
	auto p = (Plugin*)h;
	if (!p || !p->ctrl) return -1;
	if (p->view) return -2;
	p->view = owned(p->ctrl->createView(ViewType::kEditor));
	if (!p->view) return -3;
#if defined(_WIN32)
	const FIDString type = kPlatformTypeHWND;
#elif defined(__APPLE__)
	const FIDString type = kPlatformTypeNSView;
#else
	const FIDString type = kPlatformTypeX11EmbedWindowID;
#endif
	if (p->view->isPlatformTypeSupported(type) != kResultTrue) { p->view = nullptr; return -4; }
	p->frame = owned(new Frame());
	p->view->setFrame(p->frame);
	if (p->view->attached(parent, type) != kResultOk) { p->view = nullptr; return -5; }
	ViewRect r {};
	p->view->getSize(&r);
	p->frame->w = r.getWidth(); p->frame->h = r.getHeight();
	if (w) *w = r.getWidth();
	if (hgt) *hgt = r.getHeight();
	return 0;
}

/// Dimensione attuale dell'editor (cambia se il plugin lo ridimensiona).
DBV_API int dbv_editor_size(void* h, int* w, int* hgt)
{
	auto p = (Plugin*)h;
	if (!p || !p->view || !p->frame) return -1;
	*w = p->frame->w; *hgt = p->frame->h;
	return 0;
}

DBV_API void dbv_editor_close(void* h)
{
	auto p = (Plugin*)h;
	if (!p || !p->view) return;
	p->view->setFrame(nullptr);
	p->view->removed();
	p->view = nullptr;
	p->frame = nullptr;
}

DBV_API void dbv_close(void* h)
{
	auto p = (Plugin*)h;
	if (!p) return;
	dbv_editor_close(h);
	p->proc->setProcessing(false);
	p->comp->setActive(false);
	p->data.unprepare();
	if (p->ctrl) p->ctrl->setComponentHandler(nullptr);
	p->ctrl = nullptr; p->proc = nullptr; p->comp = nullptr;
	p->provider = nullptr;
	delete p;
}
